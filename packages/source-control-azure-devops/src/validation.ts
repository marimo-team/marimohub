import { ValidationError } from '@marimo-hub/core/errors';
import { isSafeWorkspaceRootPath } from '@marimo-hub/core/remote-workspace';
import type {
	OpenChangeRequestInput,
	UpdateChangeRequestInput,
} from '@marimo-hub/core/ports/source-control';

export function normalizeCommit(value: string): string {
	if (!/^[0-9a-f]{40}$/i.test(value)) throw new ValidationError('Invalid Azure DevOps commit SHA');
	return value.toLowerCase();
}
export function validateBranch(value: string): void {
	if (
		!value ||
		value === '@' ||
		value.startsWith('-') ||
		hasControlCharacter(value) ||
		value.includes(' ') ||
		/[~^:?*[\\]/.test(value) ||
		value.endsWith('.') ||
		value.includes('..') ||
		value.includes('@{') ||
		value.split('/').some((p) => !p || p.startsWith('.') || p.endsWith('.lock'))
	) {
		throw new ValidationError('Invalid Git branch name');
	}
}
export function validatePublication(input: OpenChangeRequestInput | UpdateChangeRequestInput): {
	branch: string;
	baseCommit: string;
} {
	const baseCommit = normalizeCommit(input.baseCommit);
	validateBranch(input.baseBranch);
	const branch = 'headBranch' in input ? input.headBranch : input.changeRequest.headBranch;
	validateBranch(branch);
	if (branch === input.baseBranch)
		throw new ValidationError('Proposal branch must differ from the base branch');
	if (!input.title.trim() || input.changes.length === 0)
		throw new ValidationError('A pull request requires a title and changes');
	const paths = new Set<string>();
	for (const change of input.changes) {
		if (!change.path || !isSafeWorkspaceRootPath(change.path) || paths.has(change.path))
			throw new ValidationError('Invalid or duplicate proposal path');
		paths.add(change.path);
		if (
			!['add', 'modify', 'delete'].includes(change.operation) ||
			(change.operation !== 'delete' && !(change.content instanceof Uint8Array))
		)
			throw new ValidationError('Invalid proposal change');
	}
	const author = input.coAuthor;
	if (
		author &&
		(!author.name.trim() ||
			author.name.length > 256 ||
			!/^[^\s@<>]+@[^\s@<>]+$/.test(author.email) ||
			author.email.length > 320 ||
			hasControlCharacter(author.name + author.email) ||
			/[<>\u2028\u2029]/.test(author.name + author.email))
	)
		throw new ValidationError('Invalid commit co-author');
	return { branch, baseCommit };
}

export function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 32 || code === 127) return true;
	}
	return false;
}
