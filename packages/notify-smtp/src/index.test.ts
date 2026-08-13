import { describe, expect, it, vi } from 'vitest';
import {
	BROADCAST_NOTIFICATION_FIXTURE,
	notifierContract,
	NOTIFICATION_FIXTURE,
} from '@marimo-hub/core/testing';
import { smtpTransportUrl, SmtpNotifier } from './index';

notifierContract(
	'SMTP',
	() =>
		new SmtpNotifier({
			url: 'smtp://smtp.example.com:587',
			from: 'hub@example.com',
			adminTo: ['ops@example.com'],
			mailer: { sendMail: vi.fn(async () => ({})) },
		}),
	{ personal: 'delivered', broadcast: 'delivered' },
);

describe('SmtpNotifier', () => {
	it('sends one plain-text message to the notification recipients', async () => {
		const sendMail = vi.fn(async () => ({}));
		const notifier = new SmtpNotifier({
			url: 'smtps://user:secret@smtp.example.com:465',
			from: 'marimohub <hub@example.com>',
			mailer: { sendMail },
		});

		await expect(notifier.deliver(NOTIFICATION_FIXTURE)).resolves.toBe('delivered');

		expect(sendMail).toHaveBeenCalledWith({
			from: 'marimohub <hub@example.com>',
			to: [{ address: 'member@example.com', name: 'Member' }],
			subject: NOTIFICATION_FIXTURE.title,
			text: `${NOTIFICATION_FIXTURE.body}\n\n${NOTIFICATION_FIXTURE.link}`,
		});
	});

	it('uses the administrator recipients for a broadcast notification', async () => {
		const sendMail = vi.fn(async () => ({}));
		const notifier = new SmtpNotifier({
			url: 'smtp://smtp.example.com:587',
			from: 'hub@example.com',
			adminTo: ['ops@example.com'],
			mailer: { sendMail },
		});
		await expect(notifier.deliver(BROADCAST_NOTIFICATION_FIXTURE)).resolves.toBe('delivered');
		expect(sendMail).toHaveBeenCalledWith(
			expect.objectContaining({ to: [{ address: 'ops@example.com' }] }),
		);
	});

	it('does not send a personal notification to administrator recipients', async () => {
		const sendMail = vi.fn(async () => ({}));
		const notifier = new SmtpNotifier({
			url: 'smtp://smtp.example.com:587',
			from: 'hub@example.com',
			adminTo: ['ops@example.com'],
			mailer: { sendMail },
		});

		await expect(notifier.deliver({ ...NOTIFICATION_FIXTURE, recipients: [] })).resolves.toBe(
			'skipped',
		);
		expect(sendMail).not.toHaveBeenCalled();
	});

	it('skips a broadcast notification without administrator recipients', async () => {
		const sendMail = vi.fn(async () => ({}));
		const notifier = new SmtpNotifier({
			url: 'smtp://smtp.example.com:587',
			from: 'hub@example.com',
			mailer: { sendMail },
		});

		await expect(notifier.deliver(BROADCAST_NOTIFICATION_FIXTURE)).resolves.toBe('skipped');
		expect(sendMail).not.toHaveBeenCalled();
	});

	it('rejects an invalid transport URL even when a test mailer is supplied', () => {
		expect(
			() =>
				new SmtpNotifier({
					url: 'https://smtp.example.com',
					from: 'hub@example.com',
					mailer: { sendMail: vi.fn() },
				}),
		).toThrow('Invalid SMTP URL protocol');
	});

	it('rejects a transport URL without a hostname', () => {
		expect(
			() =>
				new SmtpNotifier({
					url: 'smtp://',
					from: 'hub@example.com',
					mailer: { sendMail: vi.fn() },
				}),
		).toThrow('hostname is required');
	});

	it('enforces bounded connection, greeting, and socket timeouts', () => {
		const url = new URL(
			smtpTransportUrl(
				'smtps://user:secret@smtp.example.com:465?socketTimeout=999999&connectionTimeout=0',
			),
		);
		expect(url.searchParams.get('connectionTimeout')).toBe('10000');
		expect(url.searchParams.get('greetingTimeout')).toBe('10000');
		expect(url.searchParams.get('socketTimeout')).toBe('30000');
	});

	it('disposes the SMTP transport', async () => {
		const close = vi.fn();
		const notifier = new SmtpNotifier({
			url: 'smtp://smtp.example.com:587',
			from: 'hub@example.com',
			mailer: { sendMail: vi.fn(), close },
		});

		await notifier[Symbol.asyncDispose]();

		expect(close).toHaveBeenCalledOnce();
	});

	it.each([
		['sender', { from: 'hub@example.com\r\nBcc: attacker@example.com' }],
		['administrator recipient', { adminTo: ['ops@example.com\nBcc: attacker@example.com'] }],
	])('rejects line breaks in the %s configuration', (_label, replacement) => {
		expect(
			() =>
				new SmtpNotifier({
					url: 'smtp://smtp.example.com:587',
					from: 'hub@example.com',
					mailer: { sendMail: vi.fn() },
					...replacement,
				}),
		).toThrow('line breaks are not allowed');
	});

	it('hides transport error details', async () => {
		const notifier = new SmtpNotifier({
			url: 'smtps://user:secret@smtp.example.com:465',
			from: 'hub@example.com',
			mailer: {
				sendMail: async () => {
					throw new Error('smtps://user:secret@smtp.example.com:465');
				},
			},
		});
		const delivery = notifier.deliver(NOTIFICATION_FIXTURE);
		await expect(delivery).rejects.toThrow('SMTP notification delivery failed');
		await expect(delivery).rejects.not.toThrow('secret');
	});

	it.each([
		['title', { ...NOTIFICATION_FIXTURE, title: 'Subject\nBcc: attacker@example.com' }],
		[
			'recipient address',
			{ ...NOTIFICATION_FIXTURE, recipients: [{ email: 'member@example.com\nBcc: attacker' }] },
		],
		[
			'recipient name',
			{
				...NOTIFICATION_FIXTURE,
				recipients: [{ email: 'member@example.com', name: 'Member\r\nBcc: attacker' }],
			},
		],
	])('rejects line breaks in the notification %s', async (_label, unsafeNotification) => {
		const sendMail = vi.fn(async () => ({}));
		const notifier = new SmtpNotifier({
			url: 'smtp://smtp.example.com:587',
			from: 'hub@example.com',
			mailer: { sendMail },
		});

		await expect(notifier.deliver(unsafeNotification)).rejects.toThrow(
			'line breaks are not allowed',
		);
		expect(sendMail).not.toHaveBeenCalled();
	});
});
