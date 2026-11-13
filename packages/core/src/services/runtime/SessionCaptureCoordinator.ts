import type { Bucket } from '../../ports/bucket';
import type { SandboxInstance, SandboxProvider } from '../../ports/sandbox';
import type { Session } from '../../schema';
import type { NotebookService } from '../content/NotebookService';
import type { SessionService } from './SessionService';
import { SandboxProvisioner } from './SandboxProvisioner';
import { RuntimeCaptureClient, RuntimeCaptureError } from './runtimeCapture';
import { sessionPersistsEdits } from './sessionState';
import { workspaceSourcePolicy } from '../../integrations/remoteWorkspace';
import { captureWorkspace } from './sandboxFiles';
import type { SessionCaptureResult } from './sessionCapture';
import { logOperationalError } from '../../operationalLog';
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
		} = {},
	): Promise<SessionCaptureResult> {
		const skipped = { status: 'skipped' as const };
		if (!sessionPersistsEdits(session))
			return { critical: { status: 'not_required', reason: 'discard' }, workspace: skipped };
		const { notebooks, sessions, bucket, compute } = this.deps;
		let runtime: RuntimeCaptureClient | undefined;
		let checkpoint: Awaited<ReturnType<RuntimeCaptureClient['prepare']>> | undefined;
		let retain = false;
		let outcome: SessionCaptureResult | undefined;
		try {
			const { source } = await notebooks.getNotebook(session.project_id, session.notebook_id);
			if (source.type !== 'local')
				return {
					critical: { status: 'not_required', reason: 'remote_source' },
					workspace: skipped,
				};
			const publicationToken = await notebooks.beginSessionCapture(
				session.project_id,
				session.notebook_id,
			);
			await (options.assertOwnership?.() ?? sessions.assertCaptureOwnership(session));
			await sessions.recordCaptureAttempt(session);
			if (
				!options.retainRuntime &&
				Object.entries(session.surfaces ?? {}).some(
					([id, state]) =>
						id !== 'marimo' && ['starting', 'ready', 'stopping'].includes(state.status),
				)
			)
				throw new RuntimeCaptureError('CAPTURE_RUNTIME_UNSUPPORTED', 'running');
			if (!session.sandbox_id) throw new RuntimeCaptureError('CAPTURE_RUNTIME_UNSUPPORTED');
			runtime = new RuntimeCaptureClient(sandbox, session.sandbox_id);
			const workdir = this.deps.workdir ?? '/workspace';
			const entry = workspaceSourcePolicy(source).entryNotebook;
			checkpoint = await runtime.prepare(workdir, entry);
			const result = await new SandboxProvisioner(compute).captureSessionResult(
				sandbox,
				notebooks,
				bucket,
				session.project_id,
				session.notebook_id,
				session.user_id,
				this.deps.persistWorkspace,
				checkpoint.directory,
				{ includeWorkspace: false, publicationToken },
			);
			if (options.includeWorkspace !== false && this.deps.persistWorkspace === 'workspace') {
				try {
					await captureWorkspace(
						sandbox,
						bucket,
						session.project_id,
						session.notebook_id,
						workdir,
						'workspace',
						undefined,
						entry,
						notebooks.workspace.limits,
					);
					result.workspace = { status: 'captured' };
				} catch (cause) {
					result.workspace = { status: 'failed', cause };
				}
			}
			if (result.critical.status === 'durable') {
				try {
					await sessions.recordDurableCapture(
						session,
						result.critical.capturedAt,
						result.critical.publication.versionId,
					);
					try {
						this.deps.metrics?.increment('sessions.capture.durable');
						if (session.save_dirty)
							this.deps.metrics?.histogram?.(
								'sessions.capture.durable_lag_ms',
								Math.max(
									0,
									Date.parse(result.critical.capturedAt) -
										Date.parse(session.save_dirty.acknowledged_at),
								),
							);
					} catch {}
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
				runtimeState: cause instanceof RuntimeCaptureError ? cause.runtimeState : 'unknown',
			};
			return outcome;
		} finally {
			if (runtime && checkpoint && !retain) {
				try {
					await runtime.resume(checkpoint);
					if (outcome) outcome.runtimeState = 'running';
				} catch (error) {
					if (outcome) outcome.runtimeState = 'unknown';
					logOperationalError(
						'session_capture_resume_failed',
						{ operation: 'session.capture_resume', session_id: session.session_id },
						error,
					);
				}
			}
		}
	}
}
