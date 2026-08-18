import { describe, expect, it } from 'vitest';
import {
	gitTreeEntries,
	isRecord,
	nestedString,
	numberField,
	pullRequestUrl,
	responseJson,
	stringField,
} from './githubResponses';

describe('GitHub response fields', () => {
	it('recognizes non-array records', () => {
		expect(isRecord({})).toBe(true);
		expect(isRecord([])).toBe(false);
		expect(isRecord(null)).toBe(false);
	});

	it('reads required scalar and nested fields', () => {
		expect(stringField({ sha: 'abc123' }, 'sha')).toBe('abc123');
		expect(numberField({ number: 17 }, 'number')).toBe(17);
		expect(nestedString({ head: { sha: 'abc123' } }, 'head', 'sha')).toBe('abc123');
	});

	it.each([
		['a missing string', () => stringField({}, 'sha'), 'invalid sha'],
		['an empty string', () => stringField({ sha: '' }, 'sha'), 'invalid sha'],
		['a non-integer number', () => numberField({ number: 1.5 }, 'number'), 'invalid number'],
		['a non-positive number', () => numberField({ number: 0 }, 'number'), 'invalid number'],
		['a missing nested object', () => nestedString(null, 'head', 'sha'), 'invalid response'],
	])('rejects %s', (_label, read, message) => {
		expect(read).toThrow(message);
	});

	it('parses JSON and preserves invalid-JSON failures as service errors', async () => {
		await expect(responseJson(Response.json({ ok: true }))).resolves.toEqual({ ok: true });
		await expect(responseJson(new Response('{'))).rejects.toThrow('GitHub returned invalid JSON');
	});
});

describe('GitHub tree responses', () => {
	it('accepts each supported tree entry kind', () => {
		const entries = gitTreeEntries({
			truncated: false,
			tree: [
				{ path: 'file.py', mode: '100644', type: 'blob' },
				{ path: 'script.py', mode: '100755', type: 'blob' },
				{ path: 'link', mode: '120000', type: 'blob' },
				{ path: 'directory', mode: '040000', type: 'tree' },
				{ path: 'submodule', mode: '160000', type: 'commit' },
			],
		});

		expect([...entries]).toEqual([
			['file.py', { mode: '100644', type: 'blob' }],
			['script.py', { mode: '100755', type: 'blob' }],
			['link', { mode: '120000', type: 'blob' }],
			['directory', { mode: '040000', type: 'tree' }],
			['submodule', { mode: '160000', type: 'commit' }],
		]);
	});

	it.each([
		['a truncated tree', { truncated: true, tree: [] }, 'incomplete base tree'],
		['a missing path', { truncated: false, tree: [{}] }, 'invalid base tree entry'],
		[
			'an unsupported mode',
			{ truncated: false, tree: [{ path: 'file', mode: '040000', type: 'blob' }] },
			'invalid base tree entry',
		],
	])('rejects %s', (_label, value, message) => {
		expect(() => gitTreeEntries(value)).toThrow(message);
	});
});

describe('GitHub pull request URLs', () => {
	it('accepts the canonical GitHub URL', () => {
		expect(
			pullRequestUrl({ html_url: 'https://github.com/Owner/Repo/pull/17' }, 'owner', 'repo', 17),
		).toBe('https://github.com/Owner/Repo/pull/17');
	});

	it.each([
		['malformed URL', 'not a URL', 'invalid pull request URL'],
		['wrong protocol', 'http://github.com/owner/repo/pull/17', 'unexpected pull request URL'],
		['wrong repository', 'https://github.com/owner/other/pull/17', 'unexpected pull request URL'],
		[
			'query parameters',
			'https://github.com/owner/repo/pull/17?diff=split',
			'unexpected pull request URL',
		],
	])('rejects a %s', (_label, htmlUrl, message) => {
		expect(() => pullRequestUrl({ html_url: htmlUrl }, 'owner', 'repo', 17)).toThrow(message);
	});
});
