import { describe, expect, it } from 'vitest';
import { supportMode } from './support';

describe('support configuration', () => {
	it('defaults to off, then URL, then a usable notifier', () => {
		expect(supportMode({})).toBe('off');
		expect(supportMode({}, '/help')).toBe('url');
		expect(supportMode({ MARIMOHUB_NOTIFY_BACKENDS: 'slack' }, '/help')).toBe('notifier');
	});

	it('does not advertise filtered or untargeted notification delivery', () => {
		expect(supportMode({ MARIMOHUB_NOTIFY_BACKENDS: 'smtp' })).toBe('off');
		expect(
			supportMode({
				MARIMOHUB_NOTIFY_BACKENDS: 'smtp',
				MARIMOHUB_NOTIFY_SMTP_ADMIN_TO: 'admin@example.com',
			}),
		).toBe('notifier');
		expect(
			supportMode({ MARIMOHUB_NOTIFY_BACKENDS: 'slack', MARIMOHUB_NOTIFY_KINDS: 'none' }, '/help'),
		).toBe('url');
		expect(
			supportMode({
				MARIMOHUB_NOTIFY_BACKENDS: 'slack',
				MARIMOHUB_NOTIFY_SLACK_KINDS: 'session.takeover',
			}),
		).toBe('off');
	});

	it('allows explicit off and URL modes with a notifier configured', () => {
		expect(
			supportMode({ MARIMOHUB_SUPPORT_MODE: 'off', MARIMOHUB_NOTIFY_BACKENDS: 'slack' }, '/help'),
		).toBe('off');
		expect(
			supportMode({ MARIMOHUB_SUPPORT_MODE: 'url', MARIMOHUB_NOTIFY_BACKENDS: 'slack' }, '/help'),
		).toBe('url');
	});

	it.each(['unknown', 'notifier', 'url'])('rejects unusable mode %s at startup', (mode) => {
		expect(() => supportMode({ MARIMOHUB_SUPPORT_MODE: mode })).toThrow('MARIMOHUB_SUPPORT_MODE');
	});

	it('identifies the missing support URL and explains how to configure it', () => {
		expect(() => supportMode({ MARIMOHUB_SUPPORT_MODE: 'url' })).toThrow(
			expect.objectContaining({
				name: 'ConfigError',
				opts: {
					variable: 'MARIMOHUB_THEME_SUPPORT_URL',
					remediation: 'Set MARIMOHUB_THEME_SUPPORT_URL to an HTTPS URL or root-relative path.',
					docs: 'docs/support.md',
				},
			}),
		);
	});
});
