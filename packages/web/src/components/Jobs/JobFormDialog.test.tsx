import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JobFormDialog, parseParameters } from './JobFormDialog';
import type { Job } from '@/types';
import { jsonError, jsonOk, renderWithClient } from '@/test/render';

const PID = 'proj-x';
const NID = 'nb-1';

function makeFetch(opts: { alerts?: boolean; createResponse?: Response } = {}) {
	const calls: { url: string; method: string; body?: unknown }[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? 'GET';
			calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
			if (url.endsWith('/api/v1/capabilities')) {
				return jsonOk({
					project_alerts: { available: opts.alerts ?? true },
					jobs: {
						available: true,
						max_per_notebook: 5,
						default_timeout_seconds: 1800,
						max_timeout_seconds: 14_400,
						run_retention_days: 30,
					},
				});
			}
			if (method === 'POST' && url.endsWith('/jobs')) {
				return opts.createResponse ?? jsonOk({ id: 'job-new', name: 'x' }, { status: 201 });
			}
			if (method === 'PATCH') return jsonOk({ id: 'job-1', name: 'x' });
			throw new Error(`unexpected fetch: ${method} ${url}`);
		}),
	);
	return calls;
}

function renderDialog(job?: Job) {
	const onClose = vi.fn();
	const onSaved = vi.fn();
	renderWithClient(
		<JobFormDialog
			isOpen
			onClose={onClose}
			projectId={PID}
			notebookId={NID}
			job={job}
			onSaved={onSaved}
		/>,
	);
	return { onClose, onSaved };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('parseParameters', () => {
	it('parses key=value lines and ignores blanks', () => {
		expect(parseParameters('a=1\n\n  b=two \nc==')).toEqual({ a: '1', b: 'two', c: '=' });
	});

	it('rejects lines without a flag-safe key', () => {
		expect(() => parseParameters('just text')).toThrow('is not key=value');
		expect(() => parseParameters('b = two')).toThrow('is not key=value');
		expect(() => parseParameters('1bad=1')).toThrow('is not key=value');
		expect(() => parseParameters('=value')).toThrow('is not key=value');
	});
});

describe('JobFormDialog', () => {
	it('blocks submit until the name is set and shows field errors once touched', async () => {
		makeFetch();
		const user = userEvent.setup();
		renderDialog();
		const dialog = await screen.findByRole('dialog');
		const submit = within(dialog).getByRole('button', { name: 'Create job' });
		expect(submit).toBeDisabled();

		await user.type(within(dialog).getByLabelText('Parameters'), 'nonsense');
		expect(await within(dialog).findByText(/is not key=value/)).toBeInTheDocument();
		await user.clear(within(dialog).getByLabelText('Parameters'));

		const timeout = within(dialog).getByLabelText(/Timeout/);
		await user.type(timeout, '30');
		expect(await within(dialog).findByText('At least 60 seconds')).toBeInTheDocument();
		await user.clear(timeout);

		await user.type(within(dialog).getByLabelText('Name'), 'Report');
		await waitFor(() => expect(submit).toBeEnabled());
	});

	it('requires a cron and time zone once a schedule is enabled', async () => {
		makeFetch();
		const user = userEvent.setup();
		renderDialog();
		const dialog = await screen.findByRole('dialog');
		await user.type(within(dialog).getByLabelText('Name'), 'Report');
		await user.click(within(dialog).getByRole('switch', { name: /Manual runs only/ }));
		const cron = within(dialog).getByLabelText(/Cron/);
		await user.clear(cron);
		expect(await within(dialog).findByText('Cron expression is required')).toBeInTheDocument();
		expect(within(dialog).getByRole('button', { name: 'Create job' })).toBeDisabled();
	});

	it('hides the notification toggles when project alerts are unavailable', async () => {
		makeFetch({ alerts: false });
		renderDialog();
		const dialog = await screen.findByRole('dialog');
		await within(dialog).findByLabelText('Name');
		expect(within(dialog).queryByText(/Notify when a run fails/)).not.toBeInTheDocument();
	});

	it('surfaces a server rejection as a toast and keeps the dialog open', async () => {
		makeFetch({
			createResponse: jsonError('VALIDATION_ERROR', 'schedule.timezone: Unknown time zone', 422),
		});
		const user = userEvent.setup();
		const { onClose } = renderDialog();
		const dialog = await screen.findByRole('dialog');
		await user.type(within(dialog).getByLabelText('Name'), 'Report');
		await user.click(within(dialog).getByRole('button', { name: 'Create job' }));
		expect((await screen.findAllByText(/Unknown time zone/)).length).toBeGreaterThan(0);
		expect(onClose).not.toHaveBeenCalled();
	});

	it('seeds an edit from the job and sends notifications and retries', async () => {
		const calls = makeFetch();
		const user = userEvent.setup();
		const job: Job = {
			id: 'job-1',
			notebook_id: NID,
			project_id: PID,
			name: 'Existing',
			enabled: false,
			schedule: { cron: '15 7 * * *', timezone: 'Asia/Tokyo' },
			parameters: { region: 'ap' },
			retry: { max_retries: 2, backoff_seconds: 120 },
			timeout_seconds: 900,
			concurrency_policy: 'allow',
			notifications: { on: ['failure'] },
			created_by: 'u',
			created_at: '2026-09-01T00:00:00Z',
			updated_at: '2026-09-01T00:00:00Z',
			next_run_at: null,
		};
		const { onSaved } = renderDialog(job);
		const dialog = await screen.findByRole('dialog');
		expect(within(dialog).getByLabelText('Name')).toHaveValue('Existing');
		expect(within(dialog).getByLabelText(/Cron/)).toHaveValue('15 7 * * *');
		expect(within(dialog).getByLabelText('Parameters')).toHaveValue('region=ap');
		expect(within(dialog).getByLabelText('Retries on failure')).toHaveValue('2');

		await user.click(
			await within(dialog).findByRole('switch', { name: /Notify when a run succeeds/ }),
		);
		await user.click(within(dialog).getByRole('button', { name: 'Save' }));

		await waitFor(() => expect(onSaved).toHaveBeenCalled());
		const patch = calls.find((c) => c.method === 'PATCH');
		expect(patch?.url).toContain('/jobs/job-1');
		expect(patch?.body).toEqual({
			name: 'Existing',
			enabled: false,
			schedule: { cron: '15 7 * * *', timezone: 'Asia/Tokyo' },
			parameters: { region: 'ap' },
			retry: { max_retries: 2, backoff_seconds: 120 },
			timeout_seconds: 900,
			concurrency_policy: 'allow',
			notifications: { on: ['failure', 'success'] },
		});
	});
});
