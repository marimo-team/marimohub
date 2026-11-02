import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { apiClient } from '@/api/client';
import { renderWithClient } from '@/test/render';
import { deferred } from '@/test/deferred';
import { ReportProblemAction } from './ReportProblemDialog';
import { supportPortalUrl } from './diagnostics';
import { HelpMenu } from '@/components/Header/HelpMenu';

const DIAGNOSTICS = {
	reporter: { id: 'reporter', email: 'user@example.com' },
	page_url: 'https://hub.example/apps',
	hub_version: '1.2.3',
	timestamp: '2026-11-02T00:00:00Z',
	client: { user_agent: 'browser', viewport: { width: 800, height: 600 } },
};

function mockApi(mode: 'off' | 'url' | 'notifier' = 'notifier') {
	vi.spyOn(apiClient, 'GET').mockResolvedValue({
		data: { success: true, data: { support: { mode } } },
		response: new Response(),
	} as never);
	return vi.spyOn(apiClient, 'POST').mockImplementation(
		async (path) =>
			({
				data: {
					success: true,
					data:
						path === '/api/v1/support/diagnostics'
							? DIAGNOSTICS
							: { delivery: 'delivered', request_id: 'request-1' },
				},
				response: new Response(),
			}) as never,
	);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('Report a problem', () => {
	it('previews diagnostics and sends the message with context, not server fields', async () => {
		const post = mockApi();
		const user = userEvent.setup();
		render(<ReportProblemAction error="Render failed" />);
		await user.click(screen.getByRole('button', { name: 'Report a problem' }));
		await screen.findByRole('button', { name: 'Send report' });
		expect(screen.getByLabelText<HTMLTextAreaElement>('Diagnostics').value).toContain('1.2.3');
		expect(screen.getByRole('button', { name: 'Send report' })).toBeDisabled();
		await user.type(screen.getByLabelText('What happened?'), 'The app is blank');
		await user.click(screen.getByRole('button', { name: 'Send report' }));
		await screen.findByText('Report sent.');
		expect(post).toHaveBeenLastCalledWith('/api/v1/support/requests', {
			body: {
				message: 'The app is blank',
				page_url: expect.any(String),
				client: {
					error: 'Render failed',
					user_agent: expect.any(String),
					viewport: { width: window.innerWidth, height: window.innerHeight },
				},
			},
		});
	});

	it('keeps copy available without application providers or a working API', async () => {
		const user = userEvent.setup();
		vi.spyOn(apiClient, 'POST').mockRejectedValue(new Error('offline'));
		vi.spyOn(apiClient, 'GET').mockRejectedValue(new Error('offline'));
		const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
		render(<ReportProblemAction error="Render failed" />);
		await user.click(screen.getByRole('button', { name: 'Report a problem' }));
		await screen.findByRole('alert');
		await user.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
		expect(copy).toHaveBeenCalledWith(expect.stringContaining('Render failed'));
		expect(screen.queryByRole('button', { name: 'Send report' })).not.toBeInTheDocument();
	});

	it('opens a portal with UTF-8 diagnostics and preserves existing query parameters', async () => {
		mockApi('url');
		const user = userEvent.setup();
		renderWithClient(<ReportProblemAction />, {
			branding: { support_url: 'https://support.example/new?category=hub' },
		});
		await user.click(screen.getByRole('button', { name: 'Report a problem' }));
		await user.type(screen.getByLabelText('What happened?'), 'échec 🐛');
		const link = await screen.findByRole('link', { name: 'Open support portal' });
		const url = new URL(link.getAttribute('href')!);
		expect(url.searchParams.get('category')).toBe('hub');
		const decoded = new TextDecoder().decode(
			Uint8Array.from(atob(url.searchParams.get('diagnostics')!), (char) => char.charCodeAt(0)),
		);
		expect(JSON.parse(decoded)).toMatchObject({ message: 'échec 🐛' });
	});

	it('offers copy instead of appending oversized diagnostics', () => {
		expect(supportPortalUrl('/support', 'é'.repeat(3000))).toBeNull();
		expect(supportPortalUrl('/support', 'a'.repeat(3100))).toBeNull();
	});

	it('opens reports from the Help menu', async () => {
		mockApi('off');
		const user = userEvent.setup();
		renderWithClient(<HelpMenu />, { route: '/' });
		await user.click(screen.getByRole('button', { name: 'Help' }));
		await user.click(screen.getByRole('menuitem', { name: 'Report a problem' }));
		await waitFor(() =>
			expect(screen.getByLabelText<HTMLTextAreaElement>('Diagnostics').value).toContain('1.2.3'),
		);
		expect(screen.getByRole('button', { name: 'Copy diagnostics' })).toBeInTheDocument();
	});

	it.each([
		{ status: 429, code: 'RESOURCE_EXHAUSTED', message: 'Too many reports. Try again later.' },
		{ status: 503, code: 'UNAVAILABLE', message: 'Support delivery failed.' },
	])('preserves the draft after a $status response and allows manual retry', async (failure) => {
		const post = mockApi();
		const user = userEvent.setup();
		render(<ReportProblemAction />);
		await user.click(screen.getByRole('button', { name: 'Report a problem' }));
		await screen.findByRole('button', { name: 'Send report' });
		await user.type(screen.getByLabelText('What happened?'), 'My unsent report');
		post.mockResolvedValueOnce({
			error: { success: false, error: { code: failure.code, message: failure.message } },
			response: new Response(null, { status: failure.status }),
		} as never);
		await user.click(screen.getByRole('button', { name: 'Send report' }));
		expect(await screen.findByRole('alert')).toHaveTextContent(failure.message);
		expect(screen.getByLabelText('What happened?')).toHaveValue('My unsent report');
		expect(screen.getByRole('button', { name: 'Send report' })).toBeEnabled();
		expect(post).toHaveBeenCalledTimes(2);
		await user.click(screen.getByRole('button', { name: 'Send report' }));
		await screen.findByText('Report sent.');
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
		expect(post).toHaveBeenCalledTimes(3);
	});

	it('prevents duplicate submissions while pending and after partial delivery', async () => {
		const post = mockApi();
		const user = userEvent.setup();
		render(<ReportProblemAction />);
		await user.click(screen.getByRole('button', { name: 'Report a problem' }));
		await screen.findByRole('button', { name: 'Send report' });
		await user.type(screen.getByLabelText('What happened?'), 'The app failed');
		const pending = deferred<never>();
		post.mockReturnValueOnce(pending.promise);
		await user.dblClick(screen.getByRole('button', { name: 'Send report' }));
		expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
		expect(screen.getByLabelText('What happened?')).toBeDisabled();
		expect(post).toHaveBeenCalledTimes(2);
		await act(async () => {
			pending.resolve({
				data: { success: true, data: { delivery: 'partial', request_id: 'request-1' } },
				response: new Response(),
			} as never);
		});
		await screen.findByText('Report sent. Some support destinations could not be reached.');
		expect(screen.getByRole('button', { name: 'Send report' })).toBeDisabled();
		expect(screen.getByLabelText('What happened?')).toBeDisabled();
		expect(post).toHaveBeenCalledTimes(2);
	});

	it.each(['delivered', 'partial', 'failed'] as const)(
		'keeps the dialog open until a pending report settles as %s',
		async (outcome) => {
			const post = mockApi();
			const user = userEvent.setup();
			render(<ReportProblemAction />);
			await user.click(screen.getByRole('button', { name: 'Report a problem' }));
			await screen.findByRole('button', { name: 'Send report' });
			await user.type(screen.getByLabelText('What happened?'), 'The app failed');
			const pending = deferred<never>();
			post.mockReturnValueOnce(pending.promise);
			await user.click(screen.getByRole('button', { name: 'Send report' }));
			expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
			await user.click(screen.getByRole('button', { name: 'Close' }));
			await user.keyboard('{Escape}');
			await user.click(screen.getByRole('dialog').parentElement!.parentElement!);
			expect(screen.getByRole('dialog')).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
			expect(post).toHaveBeenCalledTimes(2);

			await act(async () => {
				if (outcome === 'failed') pending.reject(new Error('Support delivery failed.'));
				else {
					pending.resolve({
						data: { success: true, data: { delivery: outcome, request_id: 'request-1' } },
						response: new Response(),
					} as never);
				}
			});
			if (outcome === 'failed') {
				expect(screen.getByRole('alert')).toHaveTextContent('Support delivery failed.');
				expect(screen.getByRole('button', { name: 'Send report' })).toBeEnabled();
			} else {
				expect(screen.getByText(/^Report sent\./)).toBeInTheDocument();
				expect(screen.getByRole('button', { name: 'Send report' })).toBeDisabled();
			}
			expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
			await user.click(screen.getByRole('button', { name: 'Close' }));
			expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
			expect(post).toHaveBeenCalledTimes(2);
		},
	);

	it('ignores a late diagnostics response after closing and reopening the dialog', async () => {
		const post = mockApi();
		const pending = deferred<never>();
		post.mockReturnValueOnce(pending.promise);
		const user = userEvent.setup();
		render(<ReportProblemAction />);
		await user.click(screen.getByRole('button', { name: 'Report a problem' }));
		await screen.findByText('Loading diagnostics…');
		await user.click(screen.getByRole('button', { name: 'Close' }));
		await user.click(screen.getByRole('button', { name: 'Report a problem' }));
		await screen.findByRole('button', { name: 'Send report' });
		await act(async () => {
			pending.resolve({
				data: { success: true, data: { ...DIAGNOSTICS, hub_version: 'stale-version' } },
				response: new Response(),
			} as never);
		});
		const preview = screen.getByLabelText<HTMLTextAreaElement>('Diagnostics').value;
		expect(preview).toContain('1.2.3');
		expect(preview).not.toContain('stale-version');
	});

	it('preserves server diagnostics when capabilities fail and disables sending', async () => {
		mockApi();
		vi.mocked(apiClient.GET).mockRejectedValue(new Error('offline'));
		const user = userEvent.setup();
		render(<ReportProblemAction />);
		await user.click(screen.getByRole('button', { name: 'Report a problem' }));
		await screen.findByRole('alert');
		expect(screen.getByLabelText<HTMLTextAreaElement>('Diagnostics').value).toContain('1.2.3');
		expect(screen.queryByRole('button', { name: 'Send report' })).not.toBeInTheDocument();
	});

	it('offers the plain portal URL and copy when the report is too large', async () => {
		mockApi('url');
		const user = userEvent.setup();
		const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
		const supportUrl = 'https://support.example/new?category=hub';
		renderWithClient(<ReportProblemAction />, { branding: { support_url: supportUrl } });
		await user.click(screen.getByRole('button', { name: 'Report a problem' }));
		await screen.findByRole('link', { name: 'Open support portal' });
		fireEvent.change(screen.getByLabelText('What happened?'), {
			target: { value: 'é'.repeat(2000) },
		});
		expect(screen.getByText(/too large for a portal link/)).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Open support portal' })).toHaveAttribute(
			'href',
			supportUrl,
		);
		await user.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
		expect(copy).toHaveBeenCalledWith(expect.stringContaining('é'.repeat(2000)));
	});
});
