import { UnavailableError, ValidationError } from '@marimo-hub/core/errors';
import { isSafeWorkspaceRootPath } from '@marimo-hub/core/remote-workspace';
import type {
	OpenChangeRequestInput,
	UpdateChangeRequestInput,
} from '@marimo-hub/core/ports/source-control';

function parseCommit(value: unknown): string | undefined {
	return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value)
		? value.toLowerCase()
		: undefined;
}
export function normalizeCommit(value: string): string {
	const commit = parseCommit(value);
	if (!commit) throw new ValidationError('Invalid Git commit SHA');
	return commit;
}
export function normalizeProviderCommit(value: unknown): string {
	const commit = parseCommit(value);
	if (!commit) throw new UnavailableError('Invalid Git commit SHA in provider response');
	return commit;
}
export function validateBranch(
	value: unknown,
	message = 'Invalid Git branch name',
): asserts value is string {
	if (
		typeof value !== 'string' ||
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
		throw new ValidationError(message);
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
	if (hasControlCharacter(input.title) || /[\u2028\u2029]/.test(input.title))
		throw new ValidationError(
			'Pull request title must not contain control characters or line breaks',
		);
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
