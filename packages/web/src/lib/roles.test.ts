import { describe, expect, it } from 'vitest';
import { defaultAccessSummary, roleDescriptions } from './roles';
import type { Capabilities } from '@/types';

const caps = (over: Partial<Capabilities>): Capabilities =>
	({ viewer_mode: 'static', default_role: null, ...over }) as Capabilities;

describe('roleDescriptions', () => {
	it('describes viewers by the deployment viewer mode', () => {
		expect(roleDescriptions(caps({ viewer_mode: 'static' })).viewer).toMatch(/last saved outputs/);
		expect(roleDescriptions(caps({ viewer_mode: 'applications' })).viewer).toMatch(/apps/);
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
		expect(d.manager).toBeTruthy();
		expect(d.editor).toBeTruthy();
		expect(d.viewer).toBeTruthy();
	});
});

describe('defaultAccessSummary', () => {
	it('waits for inherited capabilities but can describe an explicit project setting', () => {
		expect(defaultAccessSummary('inherit')).toBeNull();
		expect(defaultAccessSummary('none')).toMatch(/members-only/);
		expect(defaultAccessSummary('viewer')).toMatch(/can view/);
	});

	it('describes inherited access without treating it as a project override', () => {
		expect(defaultAccessSummary('inherit', null)).toMatch(/Your default access: Members only/);
		expect(defaultAccessSummary('inherit', 'app-user')).toMatch(/Your default access: App user/);
		expect(defaultAccessSummary('inherit', 'editor')).toMatch(/Your default access: Editor/);
	});

	it('describes each project default independently of inherited access', () => {
		expect(defaultAccessSummary('none', 'manager')).toMatch(/members-only/);
		expect(defaultAccessSummary('app-user', 'manager')).toMatch(/without source access/);
		expect(defaultAccessSummary('viewer', 'manager')).toMatch(/can view/);
		expect(defaultAccessSummary('editor', 'manager')).toMatch(/can edit/);
		expect(defaultAccessSummary('manager', null)).toMatch(/can manage/);
	});
});
