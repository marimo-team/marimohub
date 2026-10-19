import { describe, expect, it, vi } from 'vitest';
import { emailAllowedWithInvitations } from './emailAdmission';

describe('email admission', () => {
	it.each([
		{ domains: [], email: 'guest@outside.com' },
		{ domains: ['example.com'], email: 'user@EXAMPLE.COM' },
	])('skips invitation storage for an allowed email: $email', async ({ domains, email }) => {
		const lookup = vi.fn().mockRejectedValue(new Error('unavailable'));
		await expect(emailAllowedWithInvitations(email, domains, lookup)).resolves.toBe(true);
		expect(lookup).not.toHaveBeenCalled();
	});

	it('requires an exact invitation for domains outside the allowlist', async () => {
		const lookup = vi.fn(async (email: string) => email === 'guest@outside.com');
		for (const email of ['user@sub.example.com', 'user@example.com.evil', 'other@outside.com']) {
			await expect(emailAllowedWithInvitations(email, ['example.com'], lookup)).resolves.toBe(
				false,
			);
		}
		await expect(
			emailAllowedWithInvitations('guest@outside.com', ['example.com'], lookup),
		).resolves.toBe(true);
		await expect(emailAllowedWithInvitations('guest@outside.com', ['example.com'])).resolves.toBe(
			false,
		);
	});

	it('propagates lookup failures for the authenticator to handle', async () => {
		const lookup = vi.fn().mockRejectedValue(new Error('unavailable'));
		await expect(
			emailAllowedWithInvitations('guest@outside.com', ['example.com'], lookup),
		).rejects.toThrow('unavailable');
	});
});
