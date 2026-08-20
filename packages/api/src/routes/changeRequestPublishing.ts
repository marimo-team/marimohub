import { ConflictError, NotFoundError, UnavailableError } from '@marimo-hub/core';
import type {
	GitSourceRevision,
	NotebookId,
	NotebookProposal,
	NotebookProposalRecord,
	ProjectId,
	ProposalId,
	SessionId,
	SourceControlPublisher,
	UserId,
} from '@marimo-hub/core';
import type { ApiDeps } from '../context';

interface PrepareProposalInput {
	deps: Pick<ApiDeps, 'compute' | 'sandbox' | 'services' | 'sourceControl'>;
	projectId: ProjectId;
	notebookId: NotebookId;
	sessionId: SessionId;
	proposalId: ProposalId;
	author: UserId;
	targetProposalId?: ProposalId;
}

export interface PreparedProposal {
	proposal: NotebookProposal;
	publisher?: SourceControlPublisher;
	notebookTitle?: string;
	state: 'new' | 'pending' | 'published';
}

function publisherFor(deps: PrepareProposalInput['deps'], provider: string) {
	const publisher = deps.sourceControl?.getPublisher(provider);
	if (!publisher) {
		throw new UnavailableError(`Change-request publishing is not configured for ${provider}`);
	}
	return publisher;
}

function assertReusableProposal(record: NotebookProposalRecord, input: PrepareProposalInput): void {
	const { proposal } = record;
	if (
		proposal.proposal_id !== input.proposalId ||
		proposal.notebook_id !== input.notebookId ||
		proposal.session_id !== input.sessionId ||
		proposal.author !== input.author
	) {
		throw new ConflictError('The idempotency key belongs to a different proposal');
	}
}

async function reusableProposal(
	input: PrepareProposalInput,
): Promise<NotebookProposalRecord | undefined> {
	try {
		return await input.deps.services.proposals.getReusableProposal(
			input.projectId,
			input.notebookId,
			input.proposalId,
		);
	} catch (error) {
		if (error instanceof NotFoundError) return undefined;
		throw error;
	}
}

export async function prepareProposal(input: PrepareProposalInput): Promise<PreparedProposal> {
	const reusable = await reusableProposal(input);
	if (reusable) {
		assertReusableProposal(reusable, input);
		if (reusable.publication.state === 'published') {
			return { proposal: reusable.proposal, state: 'published' };
		}
		const notebook = await input.deps.services.notebooks.getNotebook(
			input.projectId,
			input.notebookId,
		);
		return {
			proposal: reusable.proposal,
			publisher: publisherFor(input.deps, reusable.proposal.source.provider),
			notebookTitle: notebook.meta.title,
			state: 'pending',
		};
	}

	const notebook = await input.deps.services.notebooks.getNotebook(
		input.projectId,
		input.notebookId,
	);
	const session = await input.deps.services.sessions.getSession(input.projectId, input.sessionId);
	if (notebook.source.type !== 'git') {
		throw new ConflictError('Only git-synced notebooks can open change requests');
	}
	if (!session.sandbox_id) throw new ConflictError('The session has no sandbox');
	if (!session.source_version_id) {
		throw new ConflictError('The session has no synced source revision');
	}

	const legacySourceRevision: GitSourceRevision | undefined =
		session.source_version_id === notebook.source.current_version_id &&
		notebook.source.commit &&
		notebook.source.provider
			? {
					provider: notebook.source.provider,
					repo: notebook.source.repo,
					branch: notebook.source.branch,
					root_path: notebook.source.root_path,
					entry_notebook: notebook.source.entry_notebook,
					commit: notebook.source.commit,
				}
			: undefined;
	const sourceRevision = await input.deps.services.proposals.resolveSourceRevision(
		input.projectId,
		input.notebookId,
		session.source_version_id,
		legacySourceRevision,
	);
	const publisher = publisherFor(input.deps, sourceRevision.provider);
	const { proposal, created } = await input.deps.services.proposals.captureProposalWithOutcome({
		projectId: input.projectId,
		notebookId: input.notebookId,
		proposalId: input.proposalId,
		session,
		sandbox: input.deps.compute.create(session.sandbox_id),
		workdir: input.deps.sandbox.workdir,
		author: input.author,
		targetProposalId: input.targetProposalId,
		resolvedSourceRevision: sourceRevision,
	});
	return {
		proposal,
		publisher,
		notebookTitle: notebook.meta.title,
		state: created ? 'new' : 'pending',
	};
}
