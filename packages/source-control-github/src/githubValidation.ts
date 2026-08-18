import { isSafeWorkspacePath, ValidationError } from '@marimo-hub/core';
import type {
	OpenChangeRequestInput,
	SourceControlCommitIdentity,
	UpdateChangeRequestInput,
} from '@marimo-hub/core';

export interface GitHubRepository {
	owner: string;
	repo: string;
}

export function parseRepository(value: unknown): GitHubRepository {
	if (typeof value !== 'string') throw new ValidationError('GitHub repository must be owner/repo');
	let path = value.trim();
	if (/^https:\/\//i.test(path)) {
		let url: URL;
		try {
			url = new URL(path);
		} catch {
			throw new ValidationError('Invalid GitHub repository URL');
		}
		if (
			url.hostname.toLowerCase() !== 'github.com' ||
			url.port ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) {
			throw new ValidationError('GitHub publishing supports github.com repositories only');
		}
		path = url.pathname.replaceAll(/^\/+|\/+$/g, '');
	}
	const parts = path.replace(/\.git$/, '').split('/');
	const [owner, repo] = parts;
	if (
		parts.length !== 2 ||
		!owner ||
		!repo ||
		!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) ||
		!/^(?!\.+$)[A-Za-z0-9_.-]{1,100}$/.test(repo)
	) {
		throw new ValidationError('GitHub repository must be owner/repo');
	}
	return { owner, repo };
}

function hasForbiddenGitRefCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit <= 0x20 || codeUnit === 0x7f || '~^:?*[\\'.includes(value[index] ?? '')) {
			return true;
		}
	}
	return false;
}

export function validateBranch(branch: unknown): asserts branch is string {
	if (typeof branch !== 'string') throw new ValidationError('Invalid GitHub branch name');
	const components = branch.split('/');
	if (
		branch.length === 0 ||
		branch === '@' ||
		branch.startsWith('-') ||
		hasForbiddenGitRefCharacter(branch) ||
		branch.startsWith('/') ||
		branch.endsWith('/') ||
		branch.endsWith('.') ||
		branch.includes('..') ||
		branch.includes('//') ||
		branch.includes('@{') ||
		components.some((component) => component.startsWith('.') || component.endsWith('.lock'))
	) {
		throw new ValidationError('Invalid GitHub branch name');
	}
}

export function refPath(value: string): string {
	return value.split('/').map(encodeURIComponent).join('/');
}

function validateChanges(changes: unknown): asserts changes is OpenChangeRequestInput['changes'] {
	if (!Array.isArray(changes) || changes.length === 0) {
		throw new ValidationError('A pull request requires at least one change');
	}
	const paths = new Set<string>();
	for (const change of changes) {
		if (!isRecord(change) || typeof change.path !== 'string') {
			throw new ValidationError('Invalid source-control change');
		}
		if (!isSafeWorkspacePath(change.path)) {
			throw new ValidationError(`Invalid repository path: ${change.path}`);
		}
		if (paths.has(change.path)) {
			throw new ValidationError(`Duplicate repository path: ${change.path}`);
		}
		paths.add(change.path);
		if (
			typeof change.operation !== 'string' ||
			!['add', 'modify', 'delete'].includes(change.operation)
		) {
			throw new ValidationError(`Invalid operation for ${change.path}`);
		}
		if (change.operation !== 'delete' && !(change.content instanceof Uint8Array)) {
			throw new ValidationError(`Missing content for ${change.path}`);
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasUnsafeCommitIdentityCharacter(value: string): boolean {
	if (/[<>\u2028\u2029]/u.test(value)) return true;
	for (let index = 0; index < value.length; index++) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
	}
	return false;
}

export function validateCommitIdentity(
	value: unknown,
): asserts value is SourceControlCommitIdentity | undefined {
	if (value === undefined) return;
	if (!isRecord(value) || typeof value.name !== 'string' || typeof value.email !== 'string') {
		throw new ValidationError('Invalid source-control commit co-author');
	}
	if (
		value.name.length === 0 ||
		value.name.length > 256 ||
		value.name !== value.name.trim() ||
		hasUnsafeCommitIdentityCharacter(value.name)
	) {
		throw new ValidationError('Invalid source-control commit co-author name');
	}
	const at = value.email.indexOf('@');
	if (
		value.email.length > 320 ||
		at <= 0 ||
		at !== value.email.lastIndexOf('@') ||
		at === value.email.length - 1 ||
		/\s/u.test(value.email) ||
		hasUnsafeCommitIdentityCharacter(value.email)
	) {
		throw new ValidationError('Invalid source-control commit co-author email');
	}
}

export function coAuthorTrailer(coAuthor: SourceControlCommitIdentity | undefined): string {
	validateCommitIdentity(coAuthor);
	return coAuthor ? `Co-authored-by: ${coAuthor.name} <${coAuthor.email}>` : '';
}

function validateCommonInput(
	input: OpenChangeRequestInput | UpdateChangeRequestInput,
): GitHubRepository {
	const repository = parseRepository(input.repository);
	validateBranch(input.baseBranch);
	validateChanges(input.changes);
	if (typeof input.baseCommit !== 'string' || input.baseCommit.length === 0) {
		throw new ValidationError('GitHub base commit is required');
	}
	if (typeof input.title !== 'string' || input.title.trim().length === 0) {
		throw new ValidationError('GitHub pull request title is required');
	}
	if (typeof input.body !== 'string') {
		throw new ValidationError('Invalid GitHub pull request metadata');
	}
	validateCommitIdentity(input.coAuthor);
	return repository;
}

export function validateOpenInput(input: OpenChangeRequestInput): GitHubRepository {
	const repository = validateCommonInput(input);
	validateBranch(input.headBranch);
	if (typeof input.draft !== 'boolean') {
		throw new ValidationError('Invalid GitHub pull request metadata');
	}
	return repository;
}

export function validateUpdateInput(input: UpdateChangeRequestInput): GitHubRepository {
	const repository = validateCommonInput(input);
	validateBranch(input.changeRequest.headBranch);
	return repository;
}
