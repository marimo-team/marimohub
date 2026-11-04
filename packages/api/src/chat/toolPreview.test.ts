import { describe, expect, it } from 'vitest';
import { boundedOutput, toolErrorSummary, toolPreview } from './toolPreview';

describe('toolPreview', () => {
	it('redacts credential-like keys by segment and keeps look-alikes', () => {
		const preview = JSON.parse(
			toolPreview({
				access_token: 'abc',
				apiKey: 'k',
				connection_string: 'postgres://x',
				url: 'https://x',
				tokens: 42,
				security: 'high',
				curl: 'yes',
				token_count: 7,
				label: 'Bearer abc.def https://example.com/x',
			}),
		) as Record<string, unknown>;
		expect(preview.access_token).toBe('[Redacted or omitted]');
		expect(preview.apiKey).toBe('[Redacted or omitted]');
		expect(preview.connection_string).toBe('[Redacted or omitted]');
		expect(preview.url).toBe('[Redacted or omitted]');
		expect(preview.tokens).toBe(42);
		expect(preview.security).toBe('high');
		expect(preview.curl).toBe('yes');
		expect(preview.token_count).toBe('[Redacted or omitted]');
		expect(preview.label).toBe('Bearer [Redacted] [URL omitted]');
	});

	it('omits payload fields but keeps error codes', () => {
		const preview = JSON.parse(
			toolPreview({ code: 'NOT_FOUND', source: 'print(1)', stdout: 'x', message: 'Missing' }),
		) as Record<string, unknown>;
		expect(preview.code).toBe('NOT_FOUND');
		expect(preview.source).toBe('[Redacted or omitted]');
		expect(preview.stdout).toBe('[Redacted or omitted]');
		expect(preview.message).toBe('Missing');
		const code = JSON.parse(toolPreview({ code: 'import os' })) as Record<string, unknown>;
		expect(code.code).toBe('[Redacted or omitted]');
	});

	it('bounds depth, width, and length', () => {
		const deep = { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } };
		expect(toolPreview(deep)).toContain('[Omitted]');
		const wide = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]));
		expect(Object.keys(JSON.parse(toolPreview(wide)) as object)).toHaveLength(20);
		expect(toolPreview({ text: 'x'.repeat(10_000) }).length).toBeLessThanOrEqual(2000);
		expect(toolPreview('y'.repeat(5000))).toMatch(/…"$/);
	});

	it('names the Python exception behind a failed execution', () => {
		const preview = JSON.parse(
			toolPreview({ success: false, stderr: 'Traceback\nValueError: bad\n' }),
		) as Record<string, unknown>;
		expect(preview.error_type).toBe('ValueError');
	});

	it('summarizes errors briefly and safely', () => {
		expect(toolErrorSummary({ code: 'FORBIDDEN', message: 'No https://secret.example/x' })).toBe(
			'FORBIDDEN: No [URL omitted]',
		);
		expect(toolErrorSummary('Bearer abc')).toBe('Bearer [Redacted]');
		expect(toolErrorSummary({ nope: 1 })).toBeUndefined();
		expect(toolErrorSummary({ message: 'x'.repeat(500) })?.length).toBe(160);
	});

	it('caps what the model receives and lists the trimmed paths', () => {
		const output = boundedOutput({
			long: 'x'.repeat(13_000),
			many: Array.from({ length: 25 }, (_, i) => i),
		});
		expect(String(output.long)).toContain('[Remaining content omitted]');
		expect((output.many as unknown[]).length).toBe(20);
		expect(output.truncated_paths).toEqual(['$.long', '$.many']);
	});
});
