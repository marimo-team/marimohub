import { describe, expect, it } from 'vitest';
import { defaultAccessSummary, roleDescriptions } from './roles';
import type { Capabilities } from '@/types';

const caps = (over: Partial<Capabilities>): Capabilities =>
	({ viewer_mode: 'static', default_role: null, ...over }) as Capabilities;

describe('roleDescriptions', () => {
	it('describes viewers by the deployment viewer mode', () => {
		expect(roleDescriptions(caps({ viewer_mode: 'static' })).viewer).toMatch(/last saved outputs/);
		expect(roleDescriptions(caps({ viewer_mode: 'ephemeral-sandbox' })).viewer).toMatch(
			/temporary sandbox/,
		);
	});

	it('falls back to mode-neutral viewer copy while capabilities load', () => {
		expect(roleDescriptions(undefined).viewer).toMatch(/read-only/);
	});

	it('covers every role', () => {
		const d = roleDescriptions(caps({}));
		expect(d.admin).toBeTruthy();
		expect(d.editor).toBeTruthy();
		expect(d.viewer).toBeTruthy();
	});
});

describe('defaultAccessSummary', () => {
	it('is null while capabilities load', () => {
		expect(defaultAccessSummary(undefined)).toBeNull();
	});

	it('describes members-only and each open default', () => {
		expect(defaultAccessSummary(caps({ default_role: null }))).toMatch(/members-only/);
		expect(defaultAccessSummary(caps({ default_role: 'viewer' }))).toMatch(/can view/);
		expect(defaultAccessSummary(caps({ default_role: 'editor' }))).toMatch(/can edit/);
		expect(defaultAccessSummary(caps({ default_role: 'admin' }))).toMatch(/admin access/);
	});
});
