import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithClient } from '@/test/render';
import { SignIn } from './SignIn';

const signIn = vi.hoisted(() => vi.fn());

vi.mock('@/context/AuthContext', () => ({
	useAuth: () => ({ signIn }),
}));

afterEach(() => {
	signIn.mockClear();
});

describe('SignIn OIDC errors', () => {
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
		const user = userEvent.setup();
		renderWithClient(<SignIn />, { route: '/?auth_error=group_not_allowed' });

		await user.click(screen.getByRole('button', { name: 'Try a different account' }));
		expect(signIn).toHaveBeenCalledOnce();
	});
});
