import { afterEach, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { jsonOk, renderWithClient } from '@/test/render';
import { PersonalPublishingNotice } from './PersonalPublishingNotice';
afterEach(() => vi.unstubAllGlobals());
it.each([true, false])(
	'shows personal publishing identity or connection action (connected=%s)',
	async (connected) => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) =>
				String(input).endsWith('/capabilities')
					? jsonOk({ source_control: { github_publish_actor: 'user' } })
					: jsonOk({
							enabled: true,
							account: connected ? { connected, login: 'alice', account_id: '123' } : null,
						}),
			),
		);
		renderWithClient(<PersonalPublishingNotice provider="github" />, { route: '/' });
		expect(
			await screen.findByRole('link', {
				name: connected ? 'Publish as @alice · signature required' : 'Connect GitHub to publish',
			}),
		).toHaveAttribute('href', '/account/github');
	},
);
