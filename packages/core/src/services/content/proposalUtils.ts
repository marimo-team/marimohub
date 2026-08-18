import { ConflictError, ValidationError } from '../../errors';
import { isSafeWorkspacePath } from '../../integrations/remoteWorkspace';
import type { NotebookProposal, ProposalChange } from '../../schema';

export function decodeProposalContent(content: string, encoding: unknown): Uint8Array {
	if (encoding === undefined || encoding === 'utf-8') return new TextEncoder().encode(content);
	if (encoding !== 'base64') throw new ConflictError('The changed file has an invalid encoding');
	try {
		const binary = atob(content);
		return Uint8Array.from(binary, (char) => char.charCodeAt(0));
	} catch (error) {
		throw new ConflictError('The changed file has invalid base64 content', { cause: error });
	}
}

export function proposalBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

export async function proposalSha256(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function proposalChangesEqual(
	left: readonly ProposalChange[],
	right: readonly ProposalChange[],
): boolean {
	if (left.length !== right.length) return false;
	return left.every((change, index) => {
		const candidate = right[index];
		if (!candidate || change.path !== candidate.path || change.operation !== candidate.operation) {
			return false;
		}
		if (change.operation === 'delete' || candidate.operation === 'delete') return true;
		return change.size_bytes === candidate.size_bytes && change.sha256 === candidate.sha256;
	});
}

export function proposalRepositoryPath(rootPath: string, path: string): string {
	const joined = rootPath ? `${rootPath}/${path}` : path;
	if (!isSafeWorkspacePath(joined)) throw new ValidationError(`Invalid proposal path: ${joined}`);
	return joined;
}

export function proposalsShareChangeRequest(
	proposal: NotebookProposal,
	target: NotebookProposal,
): boolean {
	return (
		target.session_id === proposal.session_id &&
		target.author === proposal.author &&
		target.base_version_id === proposal.base_version_id &&
		target.source.provider === proposal.source.provider &&
		target.source.repo === proposal.source.repo &&
		target.source.branch === proposal.source.branch &&
		target.source.root_path === proposal.source.root_path &&
		target.source.entry_notebook === proposal.source.entry_notebook &&
		target.source.commit === proposal.source.commit
	);
}
