import { mapWithConcurrency } from '../../concurrency';
import { Millis } from '../../duration';
import {
	ConflictError,
	NotFoundError,
	PreconditionFailedError,
	ProposalRetryRequiredError,
	UnavailableError,
} from '../../errors';
import { createProposalId } from '../../ids';
import type { NotebookId, ProjectId, ProposalId, UserId, VersionId } from '../../ids';
import { paths } from '../../paths';
import { logOperationalError } from '../../operationalLog';
import type { Bucket } from '../../ports/bucket';
import { noopMetrics } from '../../ports/metrics';
import type { Metrics } from '../../ports/metrics';
import type {
	OpenChangeRequestResult,
	SourceControlChange,
	SourceControlCommitIdentity,
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
	ProposalPayloadMarker,
	ProposalPublication,
	Session,
} from '../../schema';
import { mutateObject } from '../catalog/cas';
import { listAllObjects } from '../catalog/storage';
import { sessionMode } from '../runtime/sessionState';
import { metricsObserver, saga } from '../../saga';
import { captureProposalChanges } from './proposalCapture';
import {
	proposalChangesEqual,
	proposalRepositoryPath,
	proposalSha256,
	proposalsShareChangeRequest,
} from './proposalUtils';

export const DEFAULT_PROPOSAL_PAYLOAD_RETENTION_MS = Millis.hours(24);
export const DEFAULT_PROPOSAL_PAYLOAD_SWEEP_GRACE_MS = Millis.hours(1);

export interface CaptureProposalInput {
	projectId: ProjectId;
	notebookId: NotebookId;
	proposalId?: ProposalId;
	session: Session;
	sandbox: SandboxInstance;
	workdir: string;
	author: UserId;
	targetProposalId?: ProposalId;
	resolvedSourceRevision?: NotebookProposal['source'];
	legacySourceRevision?: GitSourceRevision;
}

export interface PublishProposalChangeRequestInput {
	projectId: ProjectId;
	notebookId: NotebookId;
	proposalId: ProposalId;
	publisher?: SourceControlPublisher;
	title: string;
	body: string;
	coAuthor?: SourceControlCommitIdentity;
}

export interface NotebookProposalRecord {
	proposal: NotebookProposal;
	publication: ProposalPublication;
}

export interface PruneExpiredProposalPayloadsOptions {
	nowMs?: number;
}

interface PublishedChangeRequestTarget {
	rootProposalId: ProposalId;
	changeRequest: OpenChangeRequestResult;
	observedHeadCommits: ReadonlySet<string>;
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

	async captureProposal(input: CaptureProposalInput): Promise<NotebookProposal> {
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

		const capturedChanges = await captureProposalChanges(
			this.bucket,
			input.sandbox,
			input.workdir,
			base,
			source,
		);
		if (capturedChanges.changes.length === 0) {
			throw new ConflictError('The notebook workspace has no changes');
		}

		const proposalId = input.proposalId ?? createProposalId();
		const createdAt = new Date().toISOString();
		const changes = capturedChanges.changes.map(({ change }) => change);
		const proposal: NotebookProposal = {
			schema_version: 1,
			proposal_id: proposalId,
			notebook_id: input.notebookId,
			session_id: session.session_id,
			author: input.author,
			created_at: createdAt,
			base_version_id: session.source_version_id,
			capture_strategy: capturedChanges.strategy,
			source,
			target_proposal_id: input.targetProposalId,
			changes,
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

				if (
					captured.capture_strategy !== capturedChanges.strategy ||
					!proposalChangesEqual(captured.changes, changes)
				) {
					throw new ConflictError(
						'The idempotency key is already capturing different workspace content',
					);
				}

				const markerPath = paths.proposalPayloadMarker(
					input.projectId,
					input.notebookId,
					proposalId,
				);
				this.assertPayloadNotExpired(captured);
				const changeIndexes = captured.changes.flatMap((change, index) =>
					change.operation === 'delete' ? [] : [index],
				);
				const payloadMarker: ProposalPayloadMarker = {
					schema_version: 1,
					proposal_id: captured.proposal_id,
					project_id: input.projectId,
					notebook_id: input.notebookId,
					expires_at: new Date(
						Date.parse(captured.created_at) + DEFAULT_PROPOSAL_PAYLOAD_RETENTION_MS,
					).toISOString(),
					change_indexes: changeIndexes,
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
						marker.change_indexes.length !== payloadMarker.change_indexes.length ||
						marker.change_indexes.some(
							(index, position) => index !== payloadMarker.change_indexes[position],
						)
					) {
						throw new ConflictError('Proposal retention marker does not match the proposal');
					}
				}

				await mapWithConcurrency(
					capturedChanges.changes,
					16,
					async ({ change, content }, index) => {
						if (change.operation === 'delete') return;
						if (!content)
							throw new ConflictError(`Captured proposal change ${index} has no content`);
						try {
							await this.bucket.put(proposalPaths.change(index), content, {
								onlyIfNotExists: true,
							});
						} catch (error) {
							if (!(error instanceof PreconditionFailedError)) throw error;
							const existing = await this.bucket.get(proposalPaths.change(index));
							if (!existing) throw new ConflictError('Proposal content raced with another request');
							const bytes = await existing.bytes();
							if (
								bytes.byteLength !== change.size_bytes ||
								(await proposalSha256(bytes)) !== change.sha256
							) {
								throw new UnavailableError('Stored proposal content failed its integrity check');
							}
						}
					},
				);

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

	private assertProposalRetry(proposal: NotebookProposal, input: CaptureProposalInput): void {
		if (proposal.session_id !== input.session.session_id || proposal.author !== input.author) {
			throw new ConflictError('The idempotency key belongs to a different proposal');
		}
		if (
			proposal.notebook_id !== input.notebookId ||
			proposal.base_version_id !== input.session.source_version_id ||
			proposal.target_proposal_id !== input.targetProposalId
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
				if (marker.change_indexes.length > 0) {
					await this.bucket.delete(
						marker.change_indexes.map((index) => proposalPaths.change(index)),
					);
				}
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
	): Promise<NotebookProposalRecord> {
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
	): Promise<NotebookProposalRecord | undefined> {
		const record = await this.getProposal(projectId, notebookId, proposalId);
		if (record.publication.state === 'published') return record;
		const { proposal } = record;
		this.assertPayloadNotExpired(proposal);
		return (await this.hasCompletePayload(projectId, notebookId, proposal)) ? record : undefined;
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
			const result = {
				number: publication.change_request.number,
				url: publication.change_request.url,
				headBranch: publication.change_request.head_branch,
				headCommit: publication.change_request.head_commit,
			};
			if (proposal.target_proposal_id) {
				try {
					const target = await this.resolvePublishedChangeRequestTarget(
						input.projectId,
						input.notebookId,
						proposal,
						publication.change_request.provider,
					);
					await this.advanceChangeRequestHead(
						input.projectId,
						input.notebookId,
						target.rootProposalId,
						result,
						publication.change_request.provider,
						target.observedHeadCommits,
						proposal.created_at,
						'replay',
					);
				} catch (error) {
					logOperationalError(
						'proposal_change_request_head_repair_failed',
						{
							operation: 'proposal.change_request_head_repair',
							project_id: input.projectId,
							notebook_id: input.notebookId,
							proposal_id: input.proposalId,
						},
						error,
					);
				}
			}
			return result;
		}
		this.assertPayloadNotExpired(proposal);
		const publisher = input.publisher;
		if (!publisher) {
			throw new UnavailableError(
				`Change-request publishing is not configured for ${proposal.source.provider}`,
			);
		}
		if (publisher.provider !== proposal.source.provider) {
			throw new ConflictError(`No publisher is configured for ${proposal.source.provider}`);
		}

		const proposalPaths = paths
			.project(input.projectId)
			.notebook(input.notebookId)
			.proposal(input.proposalId);
		const changes = await Promise.all(
			proposal.changes.map(async (change, index): Promise<SourceControlChange> => {
				if (change.operation === 'delete') {
					return {
						path: proposalRepositoryPath(proposal.source.root_path, change.path),
						operation: 'delete',
					};
				}
				const object = await this.bucket.get(proposalPaths.change(index));
				if (!object) throw new NotFoundError(`Proposal change ${index} not found`);
				const content = await object.bytes();
				if (
					content.byteLength !== change.size_bytes ||
					(await proposalSha256(content)) !== change.sha256
				) {
					throw new UnavailableError(`Proposal change ${index} failed its integrity check`);
				}
				return {
					path: proposalRepositoryPath(proposal.source.root_path, change.path),
					operation: change.operation,
					content,
				};
			}),
		);
		let headBranch: string;
		let result: OpenChangeRequestResult;
		let expectedChangeRequest: OpenChangeRequestResult | undefined;
		let rootProposalId: ProposalId | undefined;
		let observedHeadCommits: ReadonlySet<string> | undefined;
		if (proposal.target_proposal_id) {
			const target = await this.resolvePublishedChangeRequestTarget(
				input.projectId,
				input.notebookId,
				proposal,
				publisher.provider,
			);
			if (!publisher.updateChangeRequest) {
				throw new UnavailableError(
					`Updating change requests is not configured for ${publisher.provider}`,
				);
			}
			rootProposalId = target.rootProposalId;
			expectedChangeRequest = target.changeRequest;
			observedHeadCommits = target.observedHeadCommits;
			headBranch = expectedChangeRequest.headBranch;
			result = await publisher.updateChangeRequest({
				repository: proposal.source.repo,
				baseBranch: proposal.source.branch,
				baseCommit: proposal.source.commit,
				changeRequest: expectedChangeRequest,
				title: input.title,
				body: input.body,
				coAuthor: input.coAuthor,
				changes,
			});
		} else {
			headBranch = `marimohub/${proposal.notebook_id}/${proposal.proposal_id}`;
			result = await publisher.openChangeRequest({
				repository: proposal.source.repo,
				baseBranch: proposal.source.branch,
				baseCommit: proposal.source.commit,
				headBranch,
				title: input.title,
				body: input.body,
				draft: true,
				coAuthor: input.coAuthor,
				changes,
			});
		}
		const parsedResult = ChangeRequestPublicationSchema.safeParse({
			provider: publisher.provider,
			number: result.number,
			url: result.url,
			head_branch: result.headBranch,
			head_commit: result.headCommit,
		});
		if (
			!parsedResult.success ||
			result.headBranch !== headBranch ||
			(expectedChangeRequest &&
				(result.number !== expectedChangeRequest.number ||
					result.url !== expectedChangeRequest.url))
		) {
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
						provider: publisher.provider,
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
		const publishedResult: OpenChangeRequestResult = {
			number: published.change_request.number,
			url: published.change_request.url,
			headBranch: published.change_request.head_branch,
			headCommit: published.change_request.head_commit,
		};
		if (
			published.change_request.provider !== publisher.provider ||
			publishedResult.headBranch !== headBranch ||
			(expectedChangeRequest &&
				(publishedResult.number !== expectedChangeRequest.number ||
					publishedResult.url !== expectedChangeRequest.url))
		) {
			throw new UnavailableError('Stored publication contains an invalid change request');
		}
		if (rootProposalId && expectedChangeRequest && observedHeadCommits) {
			await this.advanceChangeRequestHead(
				input.projectId,
				input.notebookId,
				rootProposalId,
				publishedResult,
				publisher.provider,
				observedHeadCommits,
				proposal.created_at,
				'publish',
			);
		}
		return publishedResult;
	}

	private async resolvePublishedChangeRequestTarget(
		projectId: ProjectId,
		notebookId: NotebookId,
		proposal: NotebookProposal,
		provider: string,
	): Promise<PublishedChangeRequestTarget> {
		let child = proposal;
		let targetId = proposal.target_proposal_id;
		const visited = new Set<ProposalId>([proposal.proposal_id]);
		let rootProposalId: ProposalId | undefined;
		let changeRequest: OpenChangeRequestResult | undefined;
		let newestUpdatedAt = '';
		const observedHeadCommits = new Set<string>();

		while (targetId) {
			if (visited.has(targetId)) {
				throw new ConflictError('The target proposal chain contains a cycle');
			}
			visited.add(targetId);
			const target = await this.getProposal(projectId, notebookId, targetId);
			if (target.publication.state !== 'published') {
				throw new ConflictError('The target proposal has no published change request');
			}
			if (!proposalsShareChangeRequest(child, target.proposal)) {
				throw new ConflictError('The target proposal belongs to a different change request');
			}
			const published = target.publication.change_request;
			observedHeadCommits.add(published.head_commit);
			if (published.provider !== provider) {
				throw new ConflictError('The target proposal uses a different source-control provider');
			}
			if (
				changeRequest &&
				(published.number !== changeRequest.number ||
					published.url !== changeRequest.url ||
					published.head_branch !== changeRequest.headBranch)
			) {
				throw new ConflictError('The target proposal chain contains different change requests');
			}
			if (!changeRequest || target.publication.updated_at > newestUpdatedAt) {
				changeRequest = {
					number: published.number,
					url: published.url,
					headBranch: published.head_branch,
					headCommit: published.head_commit,
				};
				newestUpdatedAt = target.publication.updated_at;
			}
			rootProposalId = targetId;
			child = target.proposal;
			targetId = target.proposal.target_proposal_id;
		}

		if (!rootProposalId || !changeRequest) {
			throw new ConflictError('The proposal has no target change request');
		}
		return { rootProposalId, changeRequest, observedHeadCommits };
	}

	private async advanceChangeRequestHead(
		projectId: ProjectId,
		notebookId: NotebookId,
		rootProposalId: ProposalId,
		result: OpenChangeRequestResult,
		provider: string,
		observedHeadCommits: ReadonlySet<string>,
		sourceProposalCreatedAt: string,
		mode: 'publish' | 'replay',
	): Promise<void> {
		const publicationPath = paths
			.project(projectId)
			.notebook(notebookId)
			.proposal(rootProposalId).publication;
		await mutateObject(
			this.bucket,
			publicationPath,
			(raw) => parseStored(ProposalPublicationSchema, raw, publicationPath),
			(current) => {
				if (current.state !== 'published') {
					throw new ConflictError('The target proposal has no published change request');
				}
				const changeRequest = current.change_request;
				if (
					changeRequest.provider !== provider ||
					changeRequest.number !== result.number ||
					changeRequest.url !== result.url ||
					changeRequest.head_branch !== result.headBranch
				) {
					throw new ConflictError('The target proposal changed to a different change request');
				}
				if (changeRequest.head_commit === result.headCommit) return null;
				if (
					!observedHeadCommits.has(changeRequest.head_commit) ||
					(mode === 'replay' && current.updated_at > sourceProposalCreatedAt)
				) {
					return null;
				}
				const updatedAt = new Date(
					Math.max(
						Date.now(),
						Date.parse(current.updated_at) + 1,
						Date.parse(sourceProposalCreatedAt) + 1,
					),
				).toISOString();
				return {
					...current,
					updated_at: updatedAt,
					change_request: {
						...changeRequest,
						head_commit: result.headCommit,
					},
				};
			},
		);
	}
}
