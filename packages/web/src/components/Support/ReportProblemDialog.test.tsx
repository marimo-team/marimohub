import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SUPPORT_DIAGNOSTICS_FIXTURE } from '@marimo-hub/core/testing/notification-fixtures';
import { queryClient } from '@/api/queryClient';
import { jsonError, jsonOk, renderWithClient } from '@/test/render';
import { deferred } from '@/test/deferred';
import { ReportProblemAction } from './ReportProblemDialog';
import { HelpMenu } from '@/components/Header/HelpMenu';

type Handler = () => Response | Promise<Response>;

const REQUESTS = '/api/v1/support/requests';

function stubApi(reports = true) {
	const handlers: Record<string, Handler> = {
		'/api/v1/capabilities': () => jsonOk({ support: { reports } }),
		'/api/v1/support/diagnostics': () => jsonOk(SUPPORT_DIAGNOSTICS_FIXTURE),
		[REQUESTS]: () => jsonOk({ delivery: 'delivered', request_id: 'request-1' }),
	};
	const queued: Record<string, Handler[]> = {};
	const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
		const path = String(input);
		const handler = queued[path]?.shift() ?? handlers[path];
		return handler ? handler() : jsonError('NOT_FOUND', `Unexpected request ${path}`, 404);
	});
	vi.stubGlobal('fetch', fetch);
	const sent = () => fetch.mock.calls.filter(([input]) => String(input) === REQUESTS);
	return {
		handlers,
		once: (path: string, handler: Handler) => (queued[path] ??= []).push(handler),
		sent,
		lastBody: () => JSON.parse(String(sent().at(-1)?.[1]?.body)),
	};
}

afterEach(() => {
	queryClient.clear();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('Report a problem', () => {
	it('previews diagnostics and sends the message with context, not server fields', async () => {
		const api = stubApi();
		const user = userEvent.setup();
		render(<ReportProblemAction error="Render failed" />);
		await user.click(screen.getByRole('button', { name: 'Report a problem' }));
		await screen.findByRole('button', { name: 'Send report' });
		expect(screen.getByLabelText<HTMLTextAreaElement>('Diagnostics').value).toContain('1.2.3');
		expect(screen.getByRole('button', { name: 'Send report' })).toBeDisabled();
		await user.type(screen.getByLabelText('What happened?'), 'The app is blank');
		await user.click(screen.getByRole('button', { name: 'Send report' }));
		await screen.findByText('Report sent.');
		expect(api.lastBody()).toEqual({
			message: 'The app is blank',
			page_url: expect.any(String),
			client: {
				error: 'Render failed',
				user_agent: expect.any(String),
				viewport: { width: window.innerWidth, height: window.innerHeight },
			},
		});
	});

	it('keeps copy available without application providers or a working API', async () => {
		const user = userEvent.setup();
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
		const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
		render(<ReportProblemAction error="Render failed" />);
		await user.click(screen.getByRole('button', { name: 'Report a problem' }));
		await screen.findByRole('alert');
		await user.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
		expect(copy).toHaveBeenCalledWith(expect.stringContaining('Render failed'));
		expect(screen.queryByRole('button', { name: 'Send report' })).not.toBeInTheDocument();
	});

	it('offers copy and a plain support portal link when reports are off', async () => {
		stubApi(false);
		const user = userEvent.setup();
		const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
		const supportUrl = 'https://support.example/new?category=hub';
		renderWithClient(<ReportProblemAction />, { branding: { support_url: supportUrl } });
		await user.click(screen.getByRole('button', { name: 'Report a problem' }));
		const link = await screen.findByRole('link', { name: 'Open support portal' });
		fireEvent.change(screen.getByLabelText('What happened?'), {
			target: { value: 'échec 🐛' },
		});
		expect(link).toHaveAttribute('href', supportUrl);
		expect(screen.queryByRole('button', { name: 'Send report' })).not.toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
		expect(copy).toHaveBeenCalledWith(expect.stringContaining('échec 🐛'));
	});

	it('opens reports from the Help menu', async () => {
		stubApi(false);
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
		const api = stubApi();
		const user = userEvent.setup();
		render(<ReportProblemAction />);
		await user.click(screen.getByRole('button', { name: 'Report a problem' }));
		await screen.findByRole('button', { name: 'Send report' });
		await user.type(screen.getByLabelText('What happened?'), 'My unsent report');
		api.once(REQUESTS, () => jsonError(failure.code, failure.message, failure.status));
		await user.click(screen.getByRole('button', { name: 'Send report' }));
		expect(await screen.findByRole('alert')).toHaveTextContent(failure.message);
		expect(screen.getByLabelText('What happened?')).toHaveValue('My unsent report');
		expect(screen.getByRole('button', { name: 'Send report' })).toBeEnabled();
		expect(api.sent()).toHaveLength(1);
		await user.click(screen.getByRole('button', { name: 'Send report' }));
		await screen.findByText('Report sent.');
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
		expect(api.sent()).toHaveLength(2);
	});

	it('prevents duplicate submissions while pending and after partial delivery', async () => {
		const api = stubApi();
		const user = userEvent.setup();
		render(<ReportProblemAction />);
		await user.click(screen.getByRole('button', { name: 'Report a problem' }));
		await screen.findByRole('button', { name: 'Send report' });
		await user.type(screen.getByLabelText('What happened?'), 'The app failed');
		const pending = deferred<Response>();
		api.once(REQUESTS, () => pending.promise);
		await user.dblClick(screen.getByRole('button', { name: 'Send report' }));
		expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
		expect(screen.getByLabelText('What happened?')).toBeDisabled();
		expect(api.sent()).toHaveLength(1);
		await act(async () => {
			pending.resolve(jsonOk({ delivery: 'partial', request_id: 'request-1' }));
		});
		await screen.findByText('Report sent. Some support destinations could not be reached.');
		expect(screen.getByRole('button', { name: 'Send report' })).toBeDisabled();
		expect(screen.getByLabelText('What happened?')).toBeDisabled();
		expect(api.sent()).toHaveLength(1);
	});

	it.each(['delivered', 'partial', 'failed'] as const)(
		'keeps the dialog open until a pending report settles as %s',
		async (outcome) => {
			const api = stubApi();
			const user = userEvent.setup();
			render(<ReportProblemAction />);
			await user.click(screen.getByRole('button', { name: 'Report a problem' }));
			await screen.findByRole('button', { name: 'Send report' });
			await user.type(screen.getByLabelText('What happened?'), 'The app failed');
			const pending = deferred<Response>();
			api.once(REQUESTS, () => pending.promise);
			await user.click(screen.getByRole('button', { name: 'Send report' }));
			expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
			await user.click(screen.getByRole('button', { name: 'Close' }));
			await user.keyboard('{Escape}');
			await user.click(screen.getByRole('dialog').parentElement!.parentElement!);
			expect(screen.getByRole('dialog')).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
			expect(api.sent()).toHaveLength(1);

			await act(async () => {
				pending.resolve(
					outcome === 'failed'
						? jsonError('SERVICE_UNAVAILABLE', 'Support delivery failed.', 503)
						: jsonOk({ delivery: outcome, request_id: 'request-1' }),
				);
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
			expect(api.sent()).toHaveLength(1);
		},
	);

	it('ignores a late diagnostics response after closing and reopening the dialog', async () => {
		const api = stubApi();
		const pending = deferred<Response>();
		api.once('/api/v1/support/diagnostics', () => pending.promise);
		const user = userEvent.setup();
		render(<ReportProblemAction />);
		await user.click(screen.getByRole('button', { name: 'Report a problem' }));
		await screen.findByText('Loading diagnostics…');
		await user.click(screen.getByRole('button', { name: 'Close' }));
		await user.click(screen.getByRole('button', { name: 'Report a problem' }));
		await screen.findByRole('button', { name: 'Send report' });
		await act(async () => {
			pending.resolve(jsonOk({ ...SUPPORT_DIAGNOSTICS_FIXTURE, hub_version: 'stale-version' }));
		});
		const preview = screen.getByLabelText<HTMLTextAreaElement>('Diagnostics').value;
		expect(preview).toContain('1.2.3');
		expect(preview).not.toContain('stale-version');
	});

	it('preserves server diagnostics when capabilities fail and disables sending', async () => {
		const api = stubApi();
		api.handlers['/api/v1/capabilities'] = () => jsonError('SERVICE_UNAVAILABLE', 'offline', 503);
		const user = userEvent.setup();
		render(<ReportProblemAction />);
		await user.click(screen.getByRole('button', { name: 'Report a problem' }));
		await screen.findByRole('alert');
		expect(screen.getByLabelText<HTMLTextAreaElement>('Diagnostics').value).toContain('1.2.3');
		expect(screen.queryByRole('button', { name: 'Send report' })).not.toBeInTheDocument();
	});
});
