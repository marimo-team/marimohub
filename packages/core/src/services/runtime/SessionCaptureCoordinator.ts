import { CaptureTelemetry } from '../../internal/captureTelemetry';
import type { Bucket } from '../../ports/bucket';
import type { SandboxInstance, SandboxProvider } from '../../ports/sandbox';
import type { Session } from '../../schema';
import type { NotebookService } from '../content/NotebookService';
import type { SessionService } from './SessionService';
import { SandboxProvisioner } from './SandboxProvisioner';
import { RuntimeCaptureClient, RuntimeCaptureError, RuntimeMissingError } from './runtimeCapture';
import { sessionPersistsEdits } from './sessionState';
import { workspaceSourcePolicy } from '../../integrations/remoteWorkspace';
import { captureWorkspace } from './sandboxFiles';
import type { SessionCaptureResult } from './sessionCapture';
import { logOperationalError } from '../../operationalLog';
import { logEvent } from '../../logs';
import type { Metrics } from '../../ports/metrics';

export class SessionCaptureCoordinator {
	constructor(
		private readonly deps: {
			compute: SandboxProvider;
			bucket: Bucket;
			notebooks: NotebookService;
			sessions: SessionService;
			persistWorkspace: 'source' | 'workspace';
			workdir?: string;
			metrics?: Metrics;
		},
	) {}

	async capture(
		session: Session,
		sandbox: SandboxInstance,
		options: {
			retainRuntime?: boolean;
			includeWorkspace?: boolean;
			assertOwnership?: () => Promise<void>;
			stopLease?: { attemptId: string; leaseId: string };
		} = {},
	): Promise<SessionCaptureResult> {
		const telemetry = new CaptureTelemetry(this.deps.metrics, session.save_dirty?.acknowledged_at);
		const skipped = { status: 'skipped' as const };
		if (!sessionPersistsEdits(session))
			return { critical: { status: 'not_required', reason: 'discard' }, workspace: skipped };
		const { notebooks, sessions, bucket, compute } = this.deps;
		let runtime: RuntimeCaptureClient | undefined;
		let checkpoint: Awaited<ReturnType<RuntimeCaptureClient['prepare']>> | undefined;
		let retain = false;
		let outcome: SessionCaptureResult | undefined;
		let resumed: Promise<SessionCaptureResult['runtimeState']> | undefined;
		const resume = () =>
			(resumed ??= telemetry
				.time('resume', () => runtime!.resume(checkpoint!))
				.then(
					() => 'running' as const,
					(error: unknown) => {
						logOperationalError(
							'session_capture_resume_failed',
							{ operation: 'session.capture_resume', session_id: session.session_id },
							error,
						);
						return error instanceof RuntimeMissingError
							? ('missing' as const)
							: ('unknown' as const);
					},
				));
		try {
			const publicationToken = await telemetry.time('publication_token', () =>
				notebooks.prepareSessionCapture(session.project_id, session.notebook_id),
			);
			if (!publicationToken)
				return {
					critical: { status: 'not_required', reason: 'remote_source' },
					workspace: skipped,
				};
			const { source } = publicationToken;
			await telemetry.time(
				'ownership',
				() => options.assertOwnership?.() ?? sessions.assertCaptureOwnership(session),
			);
			await telemetry.time('attempt', () => sessions.recordCaptureAttempt(session));
			if (
				!options.retainRuntime &&
				Object.entries(session.surfaces ?? {}).some(
					([id, state]) =>
						id !== 'marimo' && ['starting', 'ready', 'stopping', 'failed'].includes(state.status),
				)
			)
				throw new RuntimeCaptureError('CAPTURE_RUNTIME_UNSUPPORTED', 'running');
			if (!session.sandbox_id) throw new RuntimeCaptureError('CAPTURE_RUNTIME_UNSUPPORTED');
			runtime = new RuntimeCaptureClient(sandbox, session.sandbox_id, telemetry);
			const workdir = this.deps.workdir ?? '/workspace';
			const entry = workspaceSourcePolicy(source).entryNotebook;
			checkpoint = await telemetry.time('prepare', () => runtime!.prepare(workdir, entry));
			const result = await new SandboxProvisioner(compute).captureSessionResult(
				sandbox,
				notebooks,
				bucket,
				session.project_id,
				session.notebook_id,
				session.user_id,
				this.deps.persistWorkspace,
				checkpoint.directory,
				{
					includeWorkspace: false,
					telemetry,
					publicationToken,
					// A background save must not keep the kernel frozen through bucket and catalog writes.
					onArtifactsRead: options.retainRuntime ? undefined : resume,
					...(sessions.supportsAtomicMetadata && (!options.assertOwnership || options.stopLease)
						? { publicationAuthority: { session, stopLease: options.stopLease } }
						: {}),
				},
			);
			if (result.critical.status === 'durable') {
				const durable = result.critical;
				try {
					if (!durable.publication.captureAcknowledgedAt) {
						await telemetry.time('receipt', () =>
							sessions.recordDurableCapture(
								session,
								durable.capturedAt,
								durable.publication.versionId,
							),
						);
						telemetry.milestone('durable');
					}
					retain = !!options.retainRuntime;
					if (retain) {
						result.runtime = checkpoint;
						result.runtimeState = 'paused';
					}
				} catch (cause) {
					result.critical = {
						status: 'uncertain',
						code: 'CAPTURE_RECEIPT_FAILED',
						retryable: true,
						cause,
					};
				}
			}
			if (options.includeWorkspace !== false && this.deps.persistWorkspace === 'workspace') {
				try {
					await telemetry.time('workspace', () =>
						captureWorkspace(
							sandbox,
							bucket,
							session.project_id,
							session.notebook_id,
							workdir,
							'workspace',
							undefined,
							entry,
							notebooks.workspace.limits,
						),
					);
					result.workspace = { status: 'captured' };
				} catch (cause) {
					result.workspace = { status: 'failed', cause };
				}
			}
			outcome = result;
			return outcome;
		} catch (cause) {
			const code = cause instanceof RuntimeCaptureError ? cause.code : undefined;
			const criticalCode =
				code === 'SOURCE_MISSING' || code === 'ARTIFACT_TOO_LARGE'
					? code
					: code === 'CAPTURE_INVALID_PATH'
						? 'ARTIFACT_INVALID'
						: code?.endsWith('UNSUPPORTED')
							? 'CAPTURE_UNSUPPORTED'
							: 'RUNTIME_CAPTURE_UNAVAILABLE';
			outcome = {
				critical: {
					status: 'failed',
					code: criticalCode,
					retryable: criticalCode === 'RUNTIME_CAPTURE_UNAVAILABLE',
					cause,
				},
				workspace: skipped,
				runtimeState:
					cause instanceof RuntimeMissingError
						? 'missing'
						: cause instanceof RuntimeCaptureError
							? cause.runtimeState
							: 'unknown',
			};
			return outcome;
		} finally {
			const critical = outcome?.critical;
			const failure =
				critical?.status === 'failed' || critical?.status === 'uncertain' ? critical : undefined;
			if (outcome && (failure || outcome.workspace.status === 'failed')) {
				logEvent({
					level: 'warn',
					event: 'session_capture_incomplete',
					session_id: session.session_id,
					project_id: session.project_id,
					notebook_id: session.notebook_id,
					critical_status: outcome.critical.status,
					workspace_status: outcome.workspace.status,
					...(failure ? { code: failure.code, retryable: failure.retryable } : {}),
					last_durable_capture_at: session.last_durable_capture?.at ?? null,
					durable_capture_age_ms: session.last_durable_capture
						? Math.max(0, Date.now() - Date.parse(session.last_durable_capture.at))
						: null,
				});
			}
			if (runtime && checkpoint && !retain) {
				const state = await resume();
				if (outcome) outcome.runtimeState = state;
			}
			telemetry.complete({
				status: outcome?.critical.status ?? 'not_required',
				mode: options.retainRuntime ? 'stop' : 'background',
			});
		}
	}
}
