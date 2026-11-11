import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithClient, setupUser } from '@/test/render';
import { SignIn } from './SignIn';

const signIn = vi.hoisted(() => vi.fn());

vi.mock('@/context/AuthContext', () => ({
	useAuth: () => ({ signIn }),
}));

afterEach(() => {
	signIn.mockClear();
});

describe('SignIn OIDC errors', () => {
	it('links to configured support before authentication', () => {
		renderWithClient(<SignIn />, {
			route: '/?auth_error=policy_denied',
			branding: { support_url: 'https://support.example.com' },
		});
		expect(screen.getByRole('link', { name: 'Contact your administrator' })).toHaveAttribute(
			'href',
			'https://support.example.com',
		);
		expect(screen.getByRole('link', { name: 'Contact your administrator' })).toHaveAttribute(
			'target',
			'_blank',
		);
	});
	it('keeps root-relative support links in the current tab', () => {
		renderWithClient(<SignIn />, { route: '/', branding: { support_url: '/help' } });
		const link = screen.getByRole('link', { name: 'Contact your administrator' });
		expect(link).toHaveAttribute('href', '/help');
		expect(link).not.toHaveAttribute('target');
	});
	it.each([
		[
			'domain_not_allowed',
			'That account isn’t allowed to access this marimohub. Sign in with an authorized email address.',
		],
		[
			'email_not_verified',
			'Your email address isn’t verified with your identity provider. Verify it there, then try again.',
		],
		[
			'group_not_allowed',
			'That account is not in a group allowed to access this marimohub. Contact your administrator.',
		],
		[
			'policy_denied',
			'Your identity does not meet this marimohub access policy. Contact your administrator.',
		],
		['session_expired', 'Your sign-in session expired before it completed. Please try again.'],
		['auth_failed', 'Sign-in failed. Please try again.'],
	])('renders a helpful message for %s', (code, expected) => {
		renderWithClient(<SignIn />, { route: `/?auth_error=${code}` });

		expect(screen.getByRole('alert')).toHaveTextContent(expected);
		expect(screen.getByRole('button', { name: 'Try a different account' })).toBeInTheDocument();
	});

	it('uses the generic message for an unknown or attacker-supplied code', () => {
		renderWithClient(<SignIn />, { route: '/?auth_error=unexpected%3Cscript%3E' });

		expect(screen.getByRole('alert')).toHaveTextContent('Sign-in failed. Please try again.');
		expect(screen.queryByText(/script/i)).not.toBeInTheDocument();
	});

	it('does not show an error before a failed sign-in', () => {
		renderWithClient(<SignIn />, { route: '/' });

		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Sign in to continue' })).toBeInTheDocument();
	});

	it('retries through the normal sign-in action', async () => {
		const user = setupUser();
		renderWithClient(<SignIn />, { route: '/?auth_error=group_not_allowed' });

		await user.click(screen.getByRole('button', { name: 'Try a different account' }));
		expect(signIn).toHaveBeenCalledOnce();
	});
});
