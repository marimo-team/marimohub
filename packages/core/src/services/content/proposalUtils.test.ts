import { describe, expect, it } from 'vitest';
import { createNotebookId, createProposalId, createSessionId, createVersionId } from '../../ids';
import type { NotebookProposal, ProposalChange } from '../../schema';
import { ACTOR } from '../../testing';
import {
	decodeProposalContent,
	proposalBytesEqual,
	proposalChangesEqual,
	proposalRepositoryPath,
	proposalSha256,
	proposalsShareChangeRequest,
} from './proposalUtils';

const contentChange = (overrides: Partial<ProposalChange> = {}): ProposalChange => ({
	path: 'dashboard.py',
	operation: 'modify',
	size_bytes: 5,
	sha256: 'a'.repeat(64),
	...overrides,
});

function proposal(overrides: Partial<NotebookProposal> = {}): NotebookProposal {
	return {
		schema_version: 1,
		proposal_id: createProposalId(),
		notebook_id: createNotebookId(),
		session_id: createSessionId(),
		author: ACTOR,
		created_at: '2026-01-01T00:00:00.000Z',
		base_version_id: createVersionId(),
		capture_strategy: 'git-working-tree',
		source: {
			provider: 'github',
			repo: 'owner/repo',
			branch: 'main',
			root_path: 'apps',
			entry_notebook: 'dashboard.py',
			commit: 'abc123',
		},
		changes: [contentChange()],
		...overrides,
	};
}

describe('proposal content utilities', () => {
	it('decodes text and base64 content', () => {
		expect(decodeProposalContent('hello', undefined)).toEqual(new TextEncoder().encode('hello'));
		expect(decodeProposalContent('hello', 'utf-8')).toEqual(new TextEncoder().encode('hello'));
		expect(decodeProposalContent('AAH/', 'base64')).toEqual(new Uint8Array([0, 1, 255]));
	});

	it.each([
		['an unsupported encoding', 'hello', 'hex', 'invalid encoding'],
		['malformed base64', '%not-base64%', 'base64', 'invalid base64 content'],
	])('rejects %s', (_label, content, encoding, message) => {
		expect(() => decodeProposalContent(content, encoding)).toThrow(message);
	});

	it('compares bytes without treating prefixes as equal', () => {
		expect(proposalBytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
		expect(proposalBytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
		expect(proposalBytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
	});

	it('computes a lowercase SHA-256 digest', async () => {
		await expect(proposalSha256(new TextEncoder().encode('hello'))).resolves.toBe(
			'2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
		);
	});
});

describe('proposal comparison utilities', () => {
	it('compares ordered change manifests', () => {
		const change = contentChange();
		expect(proposalChangesEqual([change], [{ ...change }])).toBe(true);
		expect(proposalChangesEqual([change], [])).toBe(false);
		expect(proposalChangesEqual([change], [contentChange({ path: 'other.py' })])).toBe(false);
		expect(proposalChangesEqual([change], [contentChange({ operation: 'add' })])).toBe(false);
		expect(proposalChangesEqual([change], [contentChange({ size_bytes: 6 })])).toBe(false);
		expect(
			proposalChangesEqual(
				[{ path: 'old.py', operation: 'delete' }],
				[{ path: 'old.py', operation: 'delete' }],
			),
		).toBe(true);
	});

	it('joins safe repository paths and rejects traversal', () => {
		expect(proposalRepositoryPath('apps', 'dashboard.py')).toBe('apps/dashboard.py');
		expect(proposalRepositoryPath('', 'dashboard.py')).toBe('dashboard.py');
		expect(() => proposalRepositoryPath('apps', '../secret.py')).toThrow('Invalid proposal path');
	});

	it('requires immutable provenance and ownership to match', () => {
		const source = proposal();
		const matching = proposal({
			session_id: source.session_id,
			author: source.author,
			base_version_id: source.base_version_id,
			source: { ...source.source },
		});
		expect(proposalsShareChangeRequest(source, matching)).toBe(true);
		expect(
			proposalsShareChangeRequest(source, {
				...matching,
				source: { ...matching.source, commit: 'different' },
			}),
		).toBe(false);
		expect(
			proposalsShareChangeRequest(source, { ...matching, session_id: createSessionId() }),
		).toBe(false);
	});
});
