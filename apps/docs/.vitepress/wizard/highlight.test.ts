import { describe, expect, it } from 'vitest';
import { highlight } from './highlight';

describe('highlight', () => {
	it('colors .env keys, values, and comments', () => {
		const out = highlight('MARIMOHUB_STORAGE_S3_BUCKET=my-bucket', 'sh');
		expect(out).toContain('<span class="t-key">MARIMOHUB_STORAGE_S3_BUCKET</span>');
		expect(out).toContain('<span class="t-val">my-bucket</span>');
		expect(highlight('# --- Storage ---', 'sh')).toBe(
			'<span class="t-comment"># --- Storage ---</span>',
		);
	});

	it('colors TS keywords, strings, and process.env', () => {
		const out = highlight(`const x = process.env.FOO;`, 'ts');
		expect(out).toContain('<span class="t-kw">const</span>');
		expect(out).toContain('<span class="t-env">process.env.FOO</span>');
		expect(highlight(`import { a } from 'pkg';`, 'ts')).toContain(
			'<span class="t-str">\'pkg\'</span>',
		);
	});

	it('escapes HTML in values so user input cannot inject markup', () => {
		const out = highlight('MARIMOHUB_COMPUTE_IMAGE=<script>alert(1)</script>', 'sh');
		expect(out).not.toContain('<script>');
		expect(out).toContain('&lt;script&gt;');
	});
});
