import { describe, expect, it } from 'vitest';
import { supportReports } from './support';

describe('support configuration', () => {
	it('defaults to off, even with a usable notifier', () => {
		expect(supportReports({})).toBe(false);
		expect(supportReports({ MARIMOHUB_NOTIFY_BACKENDS: 'slack' })).toBe(false);
		expect(
			supportReports({ MARIMOHUB_SUPPORT_REPORTS: 'off', MARIMOHUB_NOTIFY_BACKENDS: 'slack' }),
		).toBe(false);
	});

	it('enables reports with a destination accepting support.request', () => {
		expect(
			supportReports({ MARIMOHUB_SUPPORT_REPORTS: 'on', MARIMOHUB_NOTIFY_BACKENDS: 'slack' }),
		).toBe(true);
		expect(
			supportReports({
				MARIMOHUB_SUPPORT_REPORTS: 'on',
				MARIMOHUB_NOTIFY_BACKENDS: 'smtp',
				MARIMOHUB_NOTIFY_SMTP_ADMIN_TO: 'admin@example.com',
			}),
		).toBe(true);
	});

	it.each([
		{},
		{ MARIMOHUB_NOTIFY_BACKENDS: 'smtp' },
		{ MARIMOHUB_NOTIFY_BACKENDS: 'slack', MARIMOHUB_NOTIFY_KINDS: 'none' },
		{ MARIMOHUB_NOTIFY_BACKENDS: 'slack', MARIMOHUB_NOTIFY_SLACK_KINDS: 'session.takeover' },
	])('rejects on without a destination accepting support.request (%o)', (env) => {
		expect(() => supportReports({ ...env, MARIMOHUB_SUPPORT_REPORTS: 'on' })).toThrow(
			expect.objectContaining({
				name: 'ConfigError',
				message:
					'MARIMOHUB_SUPPORT_REPORTS=on requires a notification destination accepting support.request',
				opts: { variable: 'MARIMOHUB_SUPPORT_REPORTS', docs: 'docs/support.md' },
			}),
		);
	});

	it.each(['unknown', 'notifier', 'url'])('rejects unknown value %s at startup', (value) => {
		expect(() => supportReports({ MARIMOHUB_SUPPORT_REPORTS: value })).toThrow(
			'MARIMOHUB_SUPPORT_REPORTS',
		);
	});
});
