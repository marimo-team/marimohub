import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';
import { getSetup } from './setup';
import { SELECTABLE_GROUPS } from './spec';

describe('setup snippets', () => {
	it('every selectable backend has a setup snippet + a docs deep link', () => {
		for (const group of SELECTABLE_GROUPS) {
			for (const backend of group.backends) {
				const setup = getSetup(group.key, backend.value);
				expect(setup, `${group.key}/${backend.value}`).toBeDefined();
				expect(setup!.markdown.length).toBeGreaterThan(0);
				expect(setup!.docHref).toMatch(/^\/(auth|compute|storage|ai)#/);
			}
		}
	});

	it('renders auth/oidc with all four enterprise provider sub-sections', () => {
		const html = renderMarkdown(getSetup('auth', 'oidc')!.markdown);
		for (const provider of ['Google', 'Microsoft Entra ID', 'Okta', 'Auth0']) {
			expect(html).toContain(provider);
		}
		expect(html).toMatchSnapshot();
	});

	it('renders storage/s3 including the CoreWeave CAIOS sub-section', () => {
		const html = renderMarkdown(getSetup('storage', 's3')!.markdown);
		expect(html).toContain('CoreWeave CAIOS');
		expect(html).toMatchSnapshot();
	});
});
