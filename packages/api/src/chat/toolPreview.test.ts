import { describe, expect, it } from 'vitest';
import { boundedOutput, redactSecrets, toolErrorSummary, toolPreview } from './toolPreview';

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
				private_key: '-----BEGIN',
				accessKeyId: 'AKIA',
				passphrase: 'open sesame',
				note: 'see postgres://user:pw@db.internal/app',
			}),
		) as Record<string, unknown>;
		expect(preview.private_key).toBe('[Redacted or omitted]');
		expect(preview.accessKeyId).toBe('[Redacted or omitted]');
		expect(preview.passphrase).toBe('[Redacted or omitted]');
		expect(preview.note).toBe('see [URL omitted]');
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
		const many = Object.fromEntries(
			Array.from({ length: 10 }, (_, i) => [`t${i}`, 'x'.repeat(400)]),
		);
		const capped = toolPreview(many);
		expect(capped.length).toBe(2000);
		expect(capped.endsWith('…')).toBe(true);
		expect(toolPreview('y'.repeat(5000))).toMatch(/…"$/);
	});

	it('names the Python exception behind a failed execution', () => {
		const preview = JSON.parse(
			toolPreview({ success: false, stderr: 'Traceback\nValueError: bad\n' }),
		) as Record<string, unknown>;
		expect(preview.error_type).toBe('ValueError');
	});

	it('masks inline credentials in free text and keeps links for the model', () => {
		const text =
			'Basic dXNlcjpwYXNz then token=abc123 and api_key: "k-9" at postgres://bob:hunter2@db.internal/app; token_count=7';
		const secrets = redactSecrets({
			note: text,
			password: 'p',
			nested: [{ accessKeyId: 'AKIA', href: 'https://hub.example.com/x' }],
		}) as Record<string, unknown>;
		expect(secrets.password).toBe('[Redacted]');
		expect(secrets.nested).toEqual([
			{ accessKeyId: '[Redacted]', href: 'https://hub.example.com/x' },
		]);
		expect(secrets.note).toBe(
			'Basic [Redacted] then token=[Redacted] and api_key=[Redacted] at postgres://[Redacted]@db.internal/app; token_count=7',
		);
		expect(toolErrorSummary(text)).toContain('[URL omitted]');
		expect(toolErrorSummary(text)).not.toContain('hunter2');
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
		const wide = boundedOutput({
			rows: Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`k${i}`, i])),
		});
		expect(Object.keys(wide.rows as object)).toHaveLength(100);
		expect(wide.truncated_paths).toEqual(['$.rows']);
	});
});
