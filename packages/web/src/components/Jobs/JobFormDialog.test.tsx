import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JobFormDialog } from './JobFormDialog';
import { formatJobParameters, parseJobParameters } from '@/lib/jobs';
import type { Job } from '@/types';
import { jsonError, jsonOk, renderWithClient } from '@/test/render';

const PID = 'proj-x';
const NID = 'nb-1';

function makeFetch(
	opts: { alerts?: boolean; createResponse?: Response; maxTimeout?: number } = {},
) {
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
						max_timeout_seconds: opts.maxTimeout ?? 14_400,
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

function job(overrides: Partial<Job> = {}): Job {
	return {
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
		...overrides,
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('job parameters', () => {
	it('parses raw and JSON-quoted values without losing whitespace', () => {
		expect(parseJobParameters('a=1\n\nb=" two "\nc==\nd="line\\nnext"')).toEqual({
			a: '1',
			b: ' two ',
			c: '=',
			d: 'line\nnext',
		});
		expect(formatJobParameters({ a: ' plain ', b: 'line\nnext', c: 'simple' })).toBe(
			'a=" plain "\nb="line\\nnext"\nc=simple',
		);
	});

	it('round-trips every string value through the editor format', () => {
		const parameters = {
			leading: ' value',
			trailing: 'value ',
			multiline: 'line one\nline two',
			quote: '"literal"',
			carriageReturn: 'before\rafter',
		};
		expect(parseJobParameters(formatJobParameters(parameters))).toEqual(parameters);
	});

	it('rejects lines without a flag-safe key', () => {
		expect(() => parseJobParameters('just text')).toThrow('is not key=value');
		expect(() => parseJobParameters('b = two')).toThrow('is not key=value');
		expect(() => parseJobParameters('1bad=1')).toThrow('is not key=value');
		expect(() => parseJobParameters('=value')).toThrow('is not key=value');
		expect(() => parseJobParameters('a="unterminated')).toThrow('not a valid JSON string');
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

		const parameters = within(dialog).getByLabelText('Parameters');
		await user.type(parameters, 'nonsense');
		await user.tab();
		expect(await within(dialog).findByText(/is not key=value/)).toBeInTheDocument();
		await user.clear(parameters);

		const timeout = within(dialog).getByLabelText(/Timeout/);
		await user.type(timeout, '30');
		await user.tab();
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
		const timezone = within(dialog).getByLabelText(/Time zone/);
		await user.clear(timezone);
		await user.tab();
		expect(await within(dialog).findByText('Cron expression is required')).toBeInTheDocument();
		expect(await within(dialog).findByText('Time zone is required')).toBeInTheDocument();
		expect(within(dialog).getByRole('button', { name: 'Create job' })).toBeDisabled();
	});

	it('rejects a timeout above the deployment capability limit', async () => {
		makeFetch({ maxTimeout: 120 });
		const user = userEvent.setup();
		renderDialog();
		const dialog = await screen.findByRole('dialog');
		await user.type(within(dialog).getByLabelText('Name'), 'Report');
		const timeout = await within(dialog).findByLabelText(/Timeout \(seconds, up to 120\)/);
		await user.type(timeout, '121');
		await user.tab();

		expect(await within(dialog).findByText('At most 120 seconds')).toBeInTheDocument();
		expect(within(dialog).getByRole('button', { name: 'Create job' })).toBeDisabled();
	});

	it('hides the notification toggles when project alerts are unavailable', async () => {
		makeFetch({ alerts: false });
		renderDialog();
		const dialog = await screen.findByRole('dialog');
		await within(dialog).findByLabelText('Name');
		expect(within(dialog).queryByText(/Notify when a run fails/)).not.toBeInTheDocument();
	});

	it('preserves existing notifications when project alerts are unavailable', async () => {
		const calls = makeFetch({ alerts: false });
		const user = userEvent.setup();
		renderDialog(job({ notifications: { on: ['failure', 'success'] } }));
		const dialog = await screen.findByRole('dialog');
		expect(within(dialog).queryByText(/Notify when a run fails/)).not.toBeInTheDocument();

		await user.click(within(dialog).getByRole('button', { name: 'Save' }));

		await waitFor(() =>
			expect(calls.find((call) => call.method === 'PATCH')?.body).toMatchObject({
				notifications: { on: ['failure', 'success'] },
			}),
		);
	});

	it('allows an empty retry backoff when retries are disabled', async () => {
		makeFetch();
		const user = userEvent.setup();
		renderDialog();
		const dialog = await screen.findByRole('dialog');
		await user.type(within(dialog).getByLabelText('Name'), 'Report');
		await user.clear(within(dialog).getByLabelText('Retry backoff (seconds)'));
		await user.tab();

		await waitFor(() =>
			expect(within(dialog).getByRole('button', { name: 'Create job' })).toBeEnabled(),
		);
	});

	it('requires a retry backoff when retries are enabled', async () => {
		makeFetch();
		const user = userEvent.setup();
		renderDialog();
		const dialog = await screen.findByRole('dialog');
		const retries = within(dialog).getByLabelText('Retries on failure');
		await user.clear(retries);
		await user.type(retries, '1');
		const backoff = within(dialog).getByLabelText('Retry backoff (seconds)');
		await user.clear(backoff);
		await user.tab();

		expect(await within(dialog).findByText('Whole seconds, at most 3600')).toBeInTheDocument();
		expect(within(dialog).getByRole('button', { name: 'Create job' })).toBeDisabled();
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
		const { onSaved } = renderDialog(job());
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

	it('requires an explicit supported policy before saving an unknown policy', async () => {
		const calls = makeFetch();
		const user = userEvent.setup();
		renderDialog(job({ concurrency_policy: 'unknown' }));
		const dialog = await screen.findByRole('dialog');

		expect(within(dialog).getByText(/uses an unsupported concurrency policy/)).toBeInTheDocument();
		expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();

		await user.click(within(dialog).getByRole('radio', { name: /Run anyway/ }));
		await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled());
		await user.click(within(dialog).getByRole('button', { name: 'Save' }));

		await waitFor(() =>
			expect(calls.find((call) => call.method === 'PATCH')?.body).toMatchObject({
				concurrency_policy: 'allow',
			}),
		);
	});
});
