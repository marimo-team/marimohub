import { describe, expect, it } from 'vitest';
import { UnavailableError, ValidationError } from '@marimo-hub/core/errors';
import type { OpenChangeRequestInput } from '@marimo-hub/core/ports/source-control';
import { normalizeCommit, normalizeProviderCommit, validatePublication } from './validation';

const input: OpenChangeRequestInput = {
	repository: 'https://gitlab.com/team/project',
	baseBranch: 'main',
	baseCommit: 'a'.repeat(40),
	headBranch: 'proposal',
	title: 'Update notebook',
	body: 'First paragraph\n\nSecond paragraph',
	draft: false,
	changes: [{ path: 'app.py', operation: 'add', content: new Uint8Array([1]) }],
};

describe('commit validation', () => {
	it.each(['', 'a'.repeat(39), 'g'.repeat(40), `${'a'.repeat(40)}\n`])(
		'distinguishes invalid user and provider commits: %j',
		(value) => {
			expect(() => normalizeCommit(value)).toThrow(ValidationError);
			expect(() => normalizeProviderCommit(value)).toThrow(UnavailableError);
		},
	);
	it.each([null, undefined, 123, {}, ['a'.repeat(40)]])(
		'rejects non-string provider commits: %j',
		(value) => {
			expect(() => normalizeProviderCommit(value)).toThrow(UnavailableError);
		},
	);
	it('normalizes user and provider commits without changing their identity', () => {
		const commit = 'aB'.repeat(20);
		expect(normalizeCommit(commit)).toBe(commit.toLowerCase());
		expect(normalizeProviderCommit(commit)).toBe(commit.toLowerCase());
	});
});

describe('publication titles', () => {
	it.each(['\n', '\r', '\t', '\0', '\x1f', '\x7f', '\u2028', '\u2029'])(
		'rejects title control characters and line separators: %j',
		(separator) => {
			expect(() => validatePublication({ ...input, title: `Update${separator}notebook` })).toThrow(
				'Pull request title must not contain control characters or line breaks',
			);
		},
	);
	it('accepts Unicode titles and multiline bodies', () => {
		expect(validatePublication({ ...input, title: 'Update résumé 📓' })).toEqual({
			branch: input.headBranch,
			baseCommit: input.baseCommit,
		});
	});
});
