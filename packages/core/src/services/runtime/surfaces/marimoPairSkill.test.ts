import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SURFACE_KERNEL_TOKEN_FILE_ENV, SURFACE_KERNEL_URL_ENV } from '../sandboxEnvironment';

const skill = readFileSync(
	new URL('../../../../../../images/marimo-sandbox/marimo-pair/SKILL.md', import.meta.url),
	'utf8',
);

describe('bundled marimo-pair skill', () => {
	it.each([SURFACE_KERNEL_URL_ENV, SURFACE_KERNEL_TOKEN_FILE_ENV])('reads %s', (name) => {
		expect(skill).toMatch(new RegExp(String.raw`\$\{?${name}\b`));
	});
});
