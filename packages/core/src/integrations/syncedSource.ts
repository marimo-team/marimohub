import { z } from 'zod';
import { BadRequestError } from '../errors';
import { toBase64Url } from '../internal/base64url';
import { toHex } from '../internal/hex';
import type { GitSource, Source } from '../schema';
import {
	normalizeEntryNotebook,
	normalizeWorkspaceRootPath,
	toSyncedWorkspaceFileMap,
} from './remoteWorkspace';
import type { SyncedWorkspaceFile, SyncedWorkspaceFileMap } from './remoteWorkspace';

export interface CreateSyncedNotebookInput {
	title: string;
	description: string;
	provider?: 'github';
	repo: string;
	branch: string;
	root_path?: string;
	entry_notebook: string;
	tags?: string[];
	readme?: string;
	runtime?: { python_version?: string; marimo_version?: string };
}

export interface SyncNotebookInput {
	repo: string;
	branch: string;
	root_path: string;
	commit: string;
	files: SyncedWorkspaceFile[];
}

export const SyncTokenRecordSchema = z.object({
	schema_version: z.literal(1),
	token_sha256: z.string(),
	created_at: z.iso.datetime(),
});

export type SyncTokenRecord = z.infer<typeof SyncTokenRecordSchema>;

const SYNC_TOKEN_BYTES = 32;
const SYNC_TOKEN_PREFIX = 'mhsync_';

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return toHex(new Uint8Array(digest));
}

// Constant-time comparison of two equal-length hex digests. Both operands are
// SHA-256 outputs, so length is fixed; the loop still avoids an early-exit leak.
function timingSafeEqual(a: string, b: string): boolean {
	let diff = a.length ^ b.length;
	const length = Math.max(a.length, b.length);
	for (let i = 0; i < length; i++) {
		diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
	}
	return diff === 0;
}

export function createGitSource(input: CreateSyncedNotebookInput): GitSource {
	return {
		schema_version: 1,
		type: 'git',
		provider: input.provider ?? 'github',
		repo: input.repo,
		branch: input.branch,
		root_path: normalizeWorkspaceRootPath(input.root_path),
		entry_notebook: normalizeEntryNotebook(input.entry_notebook),
		sync_mode: 'push',
		current_version_id: null,
		commit: null,
		last_synced_at: null,
	};
}

export function createSyncToken(): string {
	const bytes = new Uint8Array(SYNC_TOKEN_BYTES);
	crypto.getRandomValues(bytes);
	return `${SYNC_TOKEN_PREFIX}${toBase64Url(bytes)}`;
}

export async function createSyncTokenRecord(
	token: string,
	createdAt: string,
): Promise<SyncTokenRecord> {
	return {
		schema_version: 1,
		token_sha256: await sha256(token),
		created_at: createdAt,
	};
}

export async function verifySyncTokenRecord(
	record: SyncTokenRecord,
	token: string,
): Promise<boolean> {
	return timingSafeEqual(record.token_sha256, await sha256(token));
}

export function assertSyncedSource(source: Source): GitSource {
	if (source.type !== 'git') {
		throw new BadRequestError('Notebook is not backed by a synced source');
	}
	return source;
}

export function prepareSync(
	source: GitSource,
	input: SyncNotebookInput,
): { commit: string; files: SyncedWorkspaceFileMap } {
	const rootPath = normalizeWorkspaceRootPath(input.root_path);
	if (
		input.repo !== source.repo ||
		input.branch !== source.branch ||
		rootPath !== source.root_path
	) {
		throw new BadRequestError('Sync payload does not match the notebook source');
	}
	const commit = input.commit.trim();
	if (commit.length === 0) {
		throw new BadRequestError('commit is required');
	}

	const files = toSyncedWorkspaceFileMap(input.files);
	if (!files.has(source.entry_notebook)) {
		throw new BadRequestError(`entry_notebook not found in sync archive: ${source.entry_notebook}`);
	}
	return { commit, files };
}
