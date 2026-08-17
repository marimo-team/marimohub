import { MAX_REQUEST_BYTES } from '../../constants';
import { Millis } from '../../duration';
import {
	ConflictError,
	NotFoundError,
	PreconditionFailedError,
	ProposalRetryRequiredError,
	UnavailableError,
	ValidationError,
} from '../../errors';
import { createProposalId } from '../../ids';
import type { NotebookId, ProjectId, ProposalId, UserId, VersionId } from '../../ids';
import { isSafeWorkspacePath } from '../../integrations/remoteWorkspace';
import { paths } from '../../paths';
import { logOperationalError } from '../../operationalLog';
import type { Bucket } from '../../ports/bucket';
import { noopMetrics } from '../../ports/metrics';
import type { Metrics } from '../../ports/metrics';
import type {
	OpenChangeRequestResult,
	SourceControlChange,
	SourceControlPublisher,
} from '../../ports/sourceControl';
import type { SandboxInstance } from '../../ports/sandbox';
import {
	NotebookProposalSchema,
	ChangeRequestPublicationSchema,
	parseStored,
	ProposalPayloadMarkerSchema,
	ProposalPublicationSchema,
	readStored,
	VersionSchema,
} from '../../schema';
import type {
	GitSourceRevision,
	NotebookProposal,
	ProposalChange,
	ProposalPayloadMarker,
	ProposalPublication,
	Session,
} from '../../schema';
import { mutateObject } from '../catalog/cas';
import { listAllObjects } from '../catalog/storage';
import { sessionMode } from '../runtime/sessionState';
import { metricsObserver, saga } from '../../saga';

export const DEFAULT_PROPOSAL_PAYLOAD_RETENTION_MS = Millis.hours(24);
export const DEFAULT_PROPOSAL_PAYLOAD_SWEEP_GRACE_MS = Millis.hours(1);

export interface CaptureEntryNotebookProposalInput {
	projectId: ProjectId;
	notebookId: NotebookId;
	proposalId?: ProposalId;
	session: Session;
	sandbox: SandboxInstance;
	workdir: string;
	author: UserId;
	resolvedSourceRevision?: NotebookProposal['source'];
	legacySourceRevision?: GitSourceRevision;
}

export interface PublishProposalChangeRequestInput {
	projectId: ProjectId;
	notebookId: NotebookId;
	proposalId: ProposalId;
	publisher: SourceControlPublisher;
	title: string;
	body: string;
}

export interface PruneExpiredProposalPayloadsOptions {
	nowMs?: number;
}

function decodeFile(content: string, encoding: unknown): Uint8Array {
	if (encoding === undefined || encoding === 'utf-8') return new TextEncoder().encode(content);
	if (encoding !== 'base64') throw new ConflictError('The edited notebook has an invalid encoding');
	try {
		const binary = atob(content);
		return Uint8Array.from(binary, (char) => char.charCodeAt(0));
	} catch (error) {
		throw new ConflictError('The edited notebook has invalid base64 content', { cause: error });
	}
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let i = 0; i < left.byteLength; i++) {
		if (left[i] !== right[i]) return false;
	}
	return true;
}

async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function repoPath(rootPath: string, path: string): string {
	const joined = rootPath ? `${rootPath}/${path}` : path;
	if (!isSafeWorkspacePath(joined)) throw new ValidationError(`Invalid proposal path: ${joined}`);
	return joined;
}

export class NotebookProposalService {
	constructor(
		private bucket: Bucket,
		private metrics: Metrics = noopMetrics,
	) {}

	async resolveSourceRevision(
		projectId: ProjectId,
		notebookId: NotebookId,
		versionId: VersionId,
		legacySourceRevision?: GitSourceRevision,
	): Promise<NotebookProposal['source']> {
		const base = paths.project(projectId).notebook(notebookId).version(versionId);
		const versionObject = await this.bucket.get(base.meta);
		if (!versionObject) throw new NotFoundError(`Version ${versionId} not found`);
		const version = await readStored(VersionSchema, versionObject, base.meta);
		const source = version.git_source ?? legacySourceRevision;
		if (!source) {
			throw new ConflictError(
				'The session source version predates repository provenance tracking; restart from the latest synced version',
			);
		}
		if (source.commit !== version.commit) {
			throw new ConflictError('The session source revision is missing repository coordinates');
		}
		const provider = source.provider;
		if (!provider) {
			throw new ConflictError(
				'The session repository host has no recognized source-control provider',
			);
		}
		return { ...source, provider };
	}

	async captureEntryNotebook(input: CaptureEntryNotebookProposalInput): Promise<NotebookProposal> {
		const { session } = input;
		if (input.proposalId) {
			try {
				const { proposal, publication } = await this.getProposal(
					input.projectId,
					input.notebookId,
					input.proposalId,
				);
				this.assertProposalRetry(proposal, input);
				if (publication.state === 'published') return proposal;
				this.assertPayloadNotExpired(proposal);
				if (await this.hasCompletePayload(input.projectId, input.notebookId, proposal)) {
					return proposal;
				}
			} catch (error) {
				if (!(error instanceof NotFoundError)) throw error;
			}
		}
		if (
			session.project_id !== input.projectId ||
			session.notebook_id !== input.notebookId ||
			session.status !== 'running' ||
			sessionMode(session) !== 'edit' ||
			session.ephemeral
		) {
			throw new ConflictError('Only a running persistent editor session can open a proposal');
		}
		if (!session.source_version_id) {
			throw new ConflictError('The session has no synced source revision');
		}

		const notebook = paths.project(input.projectId).notebook(input.notebookId);
		const base = notebook.version(session.source_version_id);
		const source =
			input.resolvedSourceRevision ??
			(await this.resolveSourceRevision(
				input.projectId,
				input.notebookId,
				session.source_version_id,
				input.legacySourceRevision,
			));

		const absolutePath = `${input.workdir}/${source.entry_notebook}`;
		const listing = await input.sandbox.listFiles(absolutePath);
		if (!listing.success) throw new ConflictError('Could not inspect the edited notebook');
		const file = listing.files.find(
			(candidate) => candidate.type === 'file' && candidate.absolutePath === absolutePath,
		);
		if (!file) throw new ConflictError('The edited notebook is missing from the session');
		if (!Number.isSafeInteger(file.size) || file.size < 0) {
			throw new ConflictError('The edited notebook has invalid file metadata');
		}
		if (file.size > MAX_REQUEST_BYTES) {
			throw new ValidationError(`Edited notebook exceeds the ${MAX_REQUEST_BYTES}-byte limit`);
		}

		const [editedResult, baseObject] = await Promise.all([
			input.sandbox.readFile(absolutePath),
			this.bucket.get(base.workspaceFile(source.entry_notebook)),
		]);
		if (!editedResult.success) throw new ConflictError('Could not read the edited notebook');
		if (!baseObject) throw new NotFoundError('The synced entry notebook is missing');
		const edited = decodeFile(editedResult.content, editedResult.encoding);
		if (edited.byteLength > MAX_REQUEST_BYTES) {
			throw new ValidationError(`Edited notebook exceeds the ${MAX_REQUEST_BYTES}-byte limit`);
		}
		const original = await baseObject.bytes();
		if (bytesEqual(edited, original)) throw new ConflictError('The notebook has no changes');

		const proposalId = input.proposalId ?? createProposalId();
		const createdAt = new Date().toISOString();
		const change: ProposalChange = {
			path: source.entry_notebook,
			operation: 'modify',
			size_bytes: edited.byteLength,
			sha256: await sha256(edited),
		};
		const proposal: NotebookProposal = {
			schema_version: 1,
			proposal_id: proposalId,
			notebook_id: input.notebookId,
			session_id: session.session_id,
			author: input.author,
			created_at: createdAt,
			base_version_id: session.source_version_id,
			source,
			changes: [change],
		};
		const proposalPaths = notebook.proposal(proposalId);
		let captured = proposal;
		await saga(metricsObserver(this.metrics, 'saga.notebook_proposal_capture'))
			.step('write_proposal', async () => {
				try {
					await this.bucket.put(proposalPaths.meta, JSON.stringify(proposal), {
						onlyIfNotExists: true,
					});
				} catch (error) {
					if (!(error instanceof PreconditionFailedError)) throw error;
					const existing = await this.bucket.get(proposalPaths.meta);
					if (!existing) throw new ConflictError('Proposal capture raced with another request');
					captured = await readStored(NotebookProposalSchema, existing, proposalPaths.meta);
					this.assertProposalRetry(captured, input);
				}

				const capturedChange = captured.changes[0];
				if (
					captured.changes.length !== 1 ||
					!capturedChange ||
					capturedChange.operation === 'delete' ||
					capturedChange.path !== source.entry_notebook ||
					capturedChange.size_bytes !== edited.byteLength ||
					capturedChange.sha256 !== change.sha256
				) {
					throw new ConflictError(
						'The idempotency key is already capturing different notebook content',
					);
				}

				const markerPath = paths.proposalPayloadMarker(
					input.projectId,
					input.notebookId,
					proposalId,
				);
				this.assertPayloadNotExpired(captured);
				const payloadMarker: ProposalPayloadMarker = {
					schema_version: 1,
					proposal_id: captured.proposal_id,
					project_id: input.projectId,
					notebook_id: input.notebookId,
					expires_at: new Date(
						Date.parse(captured.created_at) + DEFAULT_PROPOSAL_PAYLOAD_RETENTION_MS,
					).toISOString(),
					change_indexes: [0],
				};
				try {
					await this.bucket.put(markerPath, JSON.stringify(payloadMarker), {
						onlyIfNotExists: true,
					});
				} catch (error) {
					if (!(error instanceof PreconditionFailedError)) throw error;
					const existing = await this.bucket.get(markerPath);
					if (!existing)
						throw new ConflictError('Proposal retention marker raced with another request');
					const marker = await readStored(ProposalPayloadMarkerSchema, existing, markerPath);
					if (
						marker.proposal_id !== captured.proposal_id ||
						marker.project_id !== input.projectId ||
						marker.notebook_id !== input.notebookId ||
						marker.expires_at !== payloadMarker.expires_at ||
						marker.change_indexes.length !== 1 ||
						marker.change_indexes[0] !== 0
					) {
						throw new ConflictError('Proposal retention marker does not match the proposal');
					}
				}

				try {
					await this.bucket.put(proposalPaths.change(0), edited, { onlyIfNotExists: true });
				} catch (error) {
					if (!(error instanceof PreconditionFailedError)) throw error;
					const existing = await this.bucket.get(proposalPaths.change(0));
					if (!existing) throw new ConflictError('Proposal content raced with another request');
					const bytes = await existing.bytes();
					if (
						bytes.byteLength !== capturedChange.size_bytes ||
						(await sha256(bytes)) !== capturedChange.sha256
					) {
						throw new UnavailableError('Stored proposal content failed its integrity check');
					}
				}

				const publication: ProposalPublication = {
					state: 'pending',
					updated_at: captured.created_at,
				};
				try {
					await this.bucket.put(proposalPaths.publication, JSON.stringify(publication), {
						onlyIfNotExists: true,
					});
				} catch (error) {
					if (!(error instanceof PreconditionFailedError)) throw error;
					const existing = await this.bucket.get(proposalPaths.publication);
					if (!existing) throw new ConflictError('Proposal state raced with another request');
					await readStored(ProposalPublicationSchema, existing, proposalPaths.publication);
				}
			})
			.run();
		return captured;
	}

	private assertProposalRetry(
		proposal: NotebookProposal,
		input: CaptureEntryNotebookProposalInput,
	): void {
		if (proposal.session_id !== input.session.session_id || proposal.author !== input.author) {
			throw new ConflictError('The idempotency key belongs to a different proposal');
		}
		if (
			proposal.notebook_id !== input.notebookId ||
			proposal.base_version_id !== input.session.source_version_id
		) {
			throw new ConflictError('The idempotency key belongs to a different source revision');
		}
	}

	private assertPayloadNotExpired(proposal: NotebookProposal): void {
		const expiresAt = Date.parse(proposal.created_at) + DEFAULT_PROPOSAL_PAYLOAD_RETENTION_MS;
		if (Date.now() >= expiresAt) {
			throw new ProposalRetryRequiredError(
				'The proposal payload expired; retry with a new idempotency key',
			);
		}
	}

	async pruneExpiredPayloads(options?: PruneExpiredProposalPayloadsOptions): Promise<number> {
		const nowMs = options?.nowMs ?? Date.now();
		if (!Number.isFinite(nowMs)) throw new RangeError('nowMs must be finite');
		const markers = await listAllObjects(this.bucket, paths.proposalPayloadMarkersPrefix);
		let pruned = 0;
		for (const listed of markers) {
			try {
				const object = await this.bucket.get(listed.key);
				if (!object) continue;
				const marker = await readStored(ProposalPayloadMarkerSchema, object, listed.key);
				if (Date.parse(marker.expires_at) + DEFAULT_PROPOSAL_PAYLOAD_SWEEP_GRACE_MS > nowMs) {
					continue;
				}
				const proposalPaths = paths
					.project(marker.project_id)
					.notebook(marker.notebook_id)
					.proposal(marker.proposal_id);
				await this.bucket.delete(marker.change_indexes.map((index) => proposalPaths.change(index)));
				await this.bucket.delete(listed.key);
				pruned++;
			} catch (error) {
				logOperationalError(
					'proposal_payload_prune_failed',
					{ operation: 'proposal.payload_prune', object: listed.key },
					error,
				);
			}
		}
		if (pruned > 0) this.metrics.increment('maintenance.proposal_payloads_pruned', pruned);
		this.metrics.gauge('proposal_payloads.count', markers.length - pruned);
		return pruned;
	}

	async getProposal(
		projectId: ProjectId,
		notebookId: NotebookId,
		proposalId: ProposalId,
	): Promise<{ proposal: NotebookProposal; publication: ProposalPublication }> {
		const proposalPaths = paths.project(projectId).notebook(notebookId).proposal(proposalId);
		const [proposalObject, publicationObject] = await Promise.all([
			this.bucket.get(proposalPaths.meta),
			this.bucket.get(proposalPaths.publication),
		]);
		if (!proposalObject || !publicationObject) {
			throw new NotFoundError(`Proposal ${proposalId} not found`);
		}
		const [proposal, publication] = await Promise.all([
			readStored(NotebookProposalSchema, proposalObject, proposalPaths.meta),
			readStored(ProposalPublicationSchema, publicationObject, proposalPaths.publication),
		]);
		return { proposal, publication };
	}

	async getReusableProposal(
		projectId: ProjectId,
		notebookId: NotebookId,
		proposalId: ProposalId,
	): Promise<NotebookProposal | undefined> {
		const { proposal, publication } = await this.getProposal(projectId, notebookId, proposalId);
		if (publication.state === 'published') return proposal;
		this.assertPayloadNotExpired(proposal);
		return (await this.hasCompletePayload(projectId, notebookId, proposal)) ? proposal : undefined;
	}

	private async hasCompletePayload(
		projectId: ProjectId,
		notebookId: NotebookId,
		proposal: NotebookProposal,
	): Promise<boolean> {
		const proposalPaths = paths
			.project(projectId)
			.notebook(notebookId)
			.proposal(proposal.proposal_id);
		const payloadExists = await Promise.all(
			proposal.changes.map(async (change, index) =>
				change.operation === 'delete' ? true : this.bucket.head(proposalPaths.change(index)),
			),
		);
		return payloadExists.every(Boolean);
	}

	async publishChangeRequest(
		input: PublishProposalChangeRequestInput,
	): Promise<OpenChangeRequestResult> {
		const { proposal, publication } = await this.getProposal(
			input.projectId,
			input.notebookId,
			input.proposalId,
		);
		if (publication.state === 'published') {
			return {
				number: publication.change_request.number,
				url: publication.change_request.url,
				headBranch: publication.change_request.head_branch,
				headCommit: publication.change_request.head_commit,
			};
		}
		this.assertPayloadNotExpired(proposal);
		if (input.publisher.provider !== proposal.source.provider) {
			throw new ConflictError(`No publisher is configured for ${proposal.source.provider}`);
		}

		const proposalPaths = paths
			.project(input.projectId)
			.notebook(input.notebookId)
			.proposal(input.proposalId);
		const changes = await Promise.all(
			proposal.changes.map(async (change, index): Promise<SourceControlChange> => {
				if (change.operation === 'delete') {
					return { path: repoPath(proposal.source.root_path, change.path), operation: 'delete' };
				}
				const object = await this.bucket.get(proposalPaths.change(index));
				if (!object) throw new NotFoundError(`Proposal change ${index} not found`);
				const content = await object.bytes();
				if (content.byteLength !== change.size_bytes || (await sha256(content)) !== change.sha256) {
					throw new UnavailableError(`Proposal change ${index} failed its integrity check`);
				}
				return {
					path: repoPath(proposal.source.root_path, change.path),
					operation: change.operation,
					content,
				};
			}),
		);
		const headBranch = `marimohub/${proposal.notebook_id}/${proposal.proposal_id}`;
		const result = await input.publisher.openChangeRequest({
			repository: proposal.source.repo,
			baseBranch: proposal.source.branch,
			baseCommit: proposal.source.commit,
			headBranch,
			title: input.title,
			body: input.body,
			draft: true,
			changes,
		});
		const parsedResult = ChangeRequestPublicationSchema.safeParse({
			provider: input.publisher.provider,
			number: result.number,
			url: result.url,
			head_branch: result.headBranch,
			head_commit: result.headCommit,
		});
		if (!parsedResult.success || result.headBranch !== headBranch) {
			throw new UnavailableError('Source-control provider returned an invalid change request');
		}

		const published = await mutateObject(
			this.bucket,
			proposalPaths.publication,
			(raw) => parseStored(ProposalPublicationSchema, raw, proposalPaths.publication),
			(current) => {
				if (current.state === 'published') return null;
				return {
					state: 'published' as const,
					updated_at: new Date().toISOString(),
					change_request: {
						provider: input.publisher.provider,
						number: result.number,
						url: result.url,
						head_branch: result.headBranch,
						head_commit: result.headCommit,
					},
				};
			},
		);
		if (published.state !== 'published') {
			throw new ConflictError('Proposal publication did not complete');
		}
		const changeRequest = published.change_request;
		return {
			number: changeRequest.number,
			url: changeRequest.url,
			headBranch: changeRequest.head_branch,
			headCommit: changeRequest.head_commit,
		};
	}
}
