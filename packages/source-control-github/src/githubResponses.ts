import { UnavailableError } from '@marimo-hub/core';

export type GitTreeEntry = {
	mode: '040000' | '100644' | '100755' | '120000' | '160000';
	type: 'blob' | 'commit' | 'tree';
};

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringField(value: unknown, field: string): string {
	if (!isRecord(value) || typeof value[field] !== 'string' || value[field].length === 0) {
		throw new UnavailableError(`GitHub returned an invalid ${field}`);
	}
	return value[field];
}

export function numberField(value: unknown, field: string): number {
	if (
		!isRecord(value) ||
		typeof value[field] !== 'number' ||
		!Number.isInteger(value[field]) ||
		value[field] <= 0
	) {
		throw new UnavailableError(`GitHub returned an invalid ${field}`);
	}
	return value[field];
}

export function nestedString(value: unknown, parent: string, field: string): string {
	if (!isRecord(value)) throw new UnavailableError('GitHub returned an invalid response');
	return stringField(value[parent], field);
}

export async function responseJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch (error) {
		throw new UnavailableError('GitHub returned invalid JSON', { cause: error });
	}
}

export function gitTreeEntries(value: unknown): Map<string, GitTreeEntry> {
	if (!isRecord(value) || value.truncated !== false || !Array.isArray(value.tree)) {
		throw new UnavailableError('GitHub returned an incomplete base tree');
	}
	const entries = new Map<string, GitTreeEntry>();
	for (const raw of value.tree) {
		if (!isRecord(raw) || typeof raw.path !== 'string') {
			throw new UnavailableError('GitHub returned an invalid base tree entry');
		}
		const mode = raw.mode;
		const type = raw.type;
		const validEntry =
			(type === 'blob' && (mode === '100644' || mode === '100755' || mode === '120000')) ||
			(type === 'tree' && mode === '040000') ||
			(type === 'commit' && mode === '160000');
		if (!validEntry) {
			throw new UnavailableError('GitHub returned an invalid base tree entry');
		}
		entries.set(raw.path, { mode, type });
	}
	return entries;
}

export function pullRequestUrl(
	value: unknown,
	owner: string,
	repo: string,
	number: number,
): string {
	const raw = stringField(value, 'html_url');
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new UnavailableError('GitHub returned an invalid pull request URL');
	}
	const expectedPath = `/${owner}/${repo}/pull/${number}`.toLowerCase();
	if (
		url.protocol !== 'https:' ||
		url.hostname.toLowerCase() !== 'github.com' ||
		url.port ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname.toLowerCase() !== expectedPath
	) {
		throw new UnavailableError('GitHub returned an unexpected pull request URL');
	}
	return raw;
}
