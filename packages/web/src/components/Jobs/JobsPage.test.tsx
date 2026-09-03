import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { JobsPage } from './JobsPage';
import type { Job, JobRun } from '@/types';
import { jsonError, jsonOk, renderWithClient } from '@/test/render';

const PID = 'proj-x';
const NID = 'nb-1';

function job(overrides: Partial<Job> = {}): Job {
	return {
		id: 'job-1',
		notebook_id: NID,
		project_id: PID,
		name: 'Nightly refresh',
		enabled: true,
		schedule: { cron: '0 6 * * *', timezone: 'Europe/Berlin' },
		concurrency_policy: 'forbid',
		created_by: 'u-1',
		created_at: '2026-09-01T10:00:00Z',
		updated_at: '2026-09-01T10:00:00Z',
		...overrides,
	};
}

function run(overrides: Partial<JobRun> = {}): JobRun {
	return {
		run_id: 'run_01',
		job_id: 'job-1',
		notebook_id: NID,
		project_id: PID,
		status: 'succeeded',
		trigger: 'schedule',
		scheduled_for: '2026-09-02T04:00:00Z',
		attempt: 1,
		timeout_seconds: 1800,
		queued_at: '2026-09-02T04:00:05Z',
		started_at: '2026-09-02T04:00:30Z',
		finished_at: '2026-09-02T04:02:30Z',
		exit_code: 0,
		output: { html_bytes: 10 },
		...overrides,
	};
}

interface World {
	role?: 'viewer' | 'editor';
	jobs?: Job[];
	runs?: JobRun[];
	olderRuns?: JobRun[];
	html?: string | null;
	logs?: string | null;
	htmlFailures?: number;
	logsFailures?: number;
	/** Fail the job list request. */
	jobsError?: boolean;
	/** The deployment has `MARIMOHUB_JOBS=off`. */
	jobsOff?: boolean;
	jobsCapabilityMissing?: boolean;
	/** Reject manual triggers with this envelope. */
	triggerError?: Response;
}

function makeFetch(world: World = {}) {
	const jobs = world.jobs ?? [job()];
	const runs = world.runs ?? [run()];
	const olderRuns = world.olderRuns ?? [];
	let htmlFailures = world.htmlFailures ?? 0;
	let logsFailures = world.logsFailures ?? 0;
	const calls: { url: string; method: string; body?: unknown; ifMatch?: string }[] = [];
	const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? 'GET';
		const ifMatch = new Headers(init?.headers).get('if-match') ?? undefined;
		calls.push({
			url,
			method,
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
			ifMatch,
		});

		if (url.endsWith('/api/v1/capabilities')) {
			return jsonOk({
				project_alerts: { available: true },
				...(world.jobsCapabilityMissing
					? {}
					: {
							jobs: world.jobsOff
								? {
										available: false,
										max_per_notebook: null,
										default_timeout_seconds: null,
										max_timeout_seconds: null,
										run_retention_days: null,
									}
								: {
										available: true,
										max_per_notebook: 5,
										default_timeout_seconds: 1800,
										max_timeout_seconds: 14_400,
										run_retention_days: 30,
									},
						}),
				compute_profiles: [],
			});
		}
		if (url.endsWith(`/projects/${PID}`)) {
			return jsonOk({
				id: PID,
				name: 'Project',
				your_role: world.role ?? 'editor',
				members: [],
				tags: [],
			});
		}
		if (url.endsWith(`/notebooks/${NID}`)) {
			return jsonOk({
				meta: { id: NID, title: 'Forecast', author: 'u-1' },
				source: { type: 'local', current_version_id: 'ver-1' },
			});
		}
		if (url.includes('/users'))
			return jsonOk({ 'u-1': { id: 'u-1', email: 'ana@x.io', name: 'Ana' } });
		if (url.endsWith('/html')) {
			if (htmlFailures > 0) {
				htmlFailures -= 1;
				return jsonError('FORBIDDEN', 'output unavailable', 403);
			}
			if (world.html === null) return jsonError('NO_RUN_OUTPUT', 'none', 404);
			return new Response(world.html ?? '<html><body>rendered</body></html>', {
				headers: { 'content-type': 'text/html' },
			});
		}
		if (url.endsWith('/logs')) {
			if (logsFailures > 0) {
				logsFailures -= 1;
				return jsonError('FORBIDDEN', 'logs unavailable', 403);
			}
			if (world.logs === null) return jsonError('NO_RUN_OUTPUT', 'none', 404);
			return new Response(world.logs ?? 'log line', { headers: { 'content-type': 'text/plain' } });
		}
		if (method === 'POST' && url.endsWith('/runs')) {
			if (world.triggerError) return world.triggerError;
			const queued = run({
				run_id: 'run_02',
				status: 'queued',
				trigger: 'manual',
				triggered_by: 'u-1',
				started_at: undefined,
				finished_at: undefined,
				exit_code: undefined,
				output: undefined,
				scheduled_for: undefined,
			});
			runs.unshift(queued);
			return jsonOk(queued, { status: 201 });
		}
		if (method === 'POST' && url.endsWith('/cancel')) {
			const target = runs.find((r) => url.includes(r.run_id));
			if (target) target.status = 'cancelled';
			return jsonOk(target);
		}
		if (method === 'POST' && url.endsWith('/jobs')) {
			const body = init?.body ? (JSON.parse(String(init.body)) as Partial<Job>) : {};
			const created = job({ id: 'job-2', ...body });
			jobs.push(created);
			return jsonOk(created, { status: 201 });
		}
		if (method === 'PATCH' && url.includes('/jobs/')) {
			const target = jobs.find((j) => url.endsWith(j.id))!;
			Object.assign(target, JSON.parse(String(init?.body)) as Partial<Job>);
			return jsonOk(target);
		}
		if (method === 'DELETE' && url.includes('/jobs/')) {
			const index = jobs.findIndex((j) => url.endsWith(j.id));
			if (index !== -1) jobs.splice(index, 1);
			return jsonOk(undefined);
		}
		const runDetail = /\/jobs\/[^/]+\/runs\/([^/?]+)$/.exec(url);
		if (method === 'GET' && runDetail) {
			const found = [...runs, ...olderRuns].find((item) => item.run_id === runDetail[1]);
			return found ? jsonOk(found) : jsonError('NOT_FOUND', 'Run not found', 404);
		}
		if (/\/jobs\/[^/]+\/runs(\?.*)?$/.test(url)) {
			const cursor = new URL(url, 'http://local').searchParams.get('cursor');
			return cursor
				? jsonOk({ items: olderRuns, next_cursor: null })
				: jsonOk({ items: runs, next_cursor: olderRuns.length > 0 ? 'older' : null });
		}
		if (new URL(url, 'http://local').pathname.endsWith(`/notebooks/${NID}/jobs`)) {
			if (world.jobsError) return jsonError('INTERNAL_ERROR', 'boom', 500);
			return jsonOk({ items: jobs, next_cursor: null });
		}
		throw new Error(`unexpected fetch: ${method} ${url}`);
	});
	vi.stubGlobal('fetch', impl);
	return { impl, calls, jobs, runs };
}

function LocationSearch() {
	return <output aria-label="Current search">{useLocation().search}</output>;
}

function renderPage(search = '') {
	return renderWithClient(
		<Routes>
			<Route
				path="/projects/:pid/notebooks/:nid/jobs"
				element={
					<>
						<JobsPage />
						<LocationSearch />
					</>
				}
			/>
		</Routes>,
		{ route: `/projects/${PID}/notebooks/${NID}/jobs${search}` },
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('JobsPage', () => {
	it('lists jobs, selects the first, and shows its run history', async () => {
		makeFetch();
		renderPage();

		expect(await screen.findByRole('heading', { name: 'Nightly refresh' })).toBeInTheDocument();
		expect(
			screen.getAllByText('0 6 * * * · Europe/Berlin', { exact: false }).length,
		).toBeGreaterThan(0);
		const rows = await screen.findAllByTestId('run-row');
		expect(rows).toHaveLength(1);
		expect(within(rows[0]).getByText('Succeeded')).toBeInTheDocument();
		expect(within(rows[0]).getByText('schedule')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Nightly refresh/ })).toHaveAttribute(
			'aria-pressed',
			'true',
		);
	});

	it('loads additional run-history pages', async () => {
		makeFetch({ olderRuns: [run({ run_id: 'run_old' })] });
		const user = userEvent.setup();
		renderPage();
		expect(await screen.findAllByTestId('run-row')).toHaveLength(1);
		await user.click(screen.getByRole('button', { name: 'Load more runs' }));
		expect(await screen.findAllByTestId('run-row')).toHaveLength(2);
	});

	it('loads a directly linked run that is not on the first history page', async () => {
		makeFetch({ olderRuns: [run({ run_id: 'run_old' })] });
		renderPage('?job=job-1&run=run_old');
		expect(await screen.findByText(/Duration 2m/)).toBeInTheDocument();
	});

	it('explains an off deployment instead of loading jobs', async () => {
		const { calls } = makeFetch({ jobsOff: true });
		renderPage();
		expect(await screen.findByText('Notebook jobs are off on this deployment')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'New job' })).not.toBeInTheDocument();
		expect(calls.some((call) => call.url.endsWith('/jobs'))).toBe(false);
	});

	it('treats a missing jobs capability as unavailable', async () => {
		const { calls } = makeFetch({ jobsCapabilityMissing: true });
		renderPage();
		expect(await screen.findByText('Notebook jobs are off on this deployment')).toBeInTheDocument();
		expect(
			calls.some(
				(call) =>
					call.method === 'GET' &&
					new URL(call.url, 'http://local').pathname.endsWith(`/notebooks/${NID}/jobs`),
			),
		).toBe(false);
	});

	it('opens a run’s rendered output in an opaque-origin iframe', async () => {
		makeFetch();
		const user = userEvent.setup();
		const { container } = renderPage();

		const row = (await screen.findAllByTestId('run-row'))[0];
		await user.click(within(row).getByRole('button'));
		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
		const iframe = container.querySelector('iframe')!;
		expect(iframe.getAttribute('srcdoc')).toContain('rendered');
		expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
		expect(screen.getByText(/Duration 2m/)).toBeInTheDocument();
	});

	it('opens a run from the keyboard', async () => {
		makeFetch();
		const user = userEvent.setup();
		renderPage();
		const row = (await screen.findAllByTestId('run-row'))[0];
		const button = within(row).getByRole('button');
		button.focus();
		expect(button).toHaveClass('focus-visible:ring-2');
		await user.keyboard('{Enter}');
		expect(await screen.findByText(/Duration 2m/)).toBeInTheDocument();
	});

	it('persists the selected job when linking to a run', async () => {
		makeFetch();
		const user = userEvent.setup();
		renderPage();
		const row = (await screen.findAllByTestId('run-row'))[0];

		await user.click(within(row).getByRole('button'));

		expect(screen.getByRole('status', { name: 'Current search' })).toHaveTextContent(
			'?job=job-1&run=run_01',
		);
	});

	it('shows logs to editors on the Logs tab', async () => {
		makeFetch({ logs: 'Traceback: boom' });
		const user = userEvent.setup();
		renderPage('?job=job-1&run=run_01');

		await user.click(await screen.findByRole('tab', { name: 'Logs' }));
		expect(await screen.findByText('Traceback: boom')).toBeInTheDocument();
	});

	it('shows an empty state when a run has no logs', async () => {
		makeFetch({ logs: ' \n' });
		const user = userEvent.setup();
		renderPage('?job=job-1&run=run_01');

		await user.click(await screen.findByRole('tab', { name: 'Logs' }));
		expect(await screen.findByText('No logs were captured for this run.')).toHaveClass('italic');
	});

	it('associates artifact tabs with their panel and supports arrow-key navigation', async () => {
		makeFetch();
		const user = userEvent.setup();
		renderPage('?job=job-1&run=run_01');

		const outputTab = await screen.findByRole('tab', { name: 'Output' });
		const logsTab = screen.getByRole('tab', { name: 'Logs' });
		const panel = screen.getByRole('tabpanel');
		expect(outputTab).toHaveAttribute('aria-selected', 'true');
		expect(outputTab).toHaveAttribute('aria-controls', panel.id);
		expect(panel).toHaveAttribute('aria-labelledby', outputTab.id);

		outputTab.focus();
		await user.keyboard('{ArrowRight}');
		expect(logsTab).toHaveFocus();
		expect(logsTab).toHaveAttribute('aria-selected', 'true');
		expect(panel).toHaveAttribute('aria-labelledby', logsTab.id);
	});

	it('shows an output request error and retries it', async () => {
		makeFetch({ htmlFailures: 1 });
		const user = userEvent.setup();
		const { container } = renderPage('?job=job-1&run=run_01');

		expect(await screen.findByText('Failed to load run output.')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Retry' }));
		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
	});

	it('shows a logs request error and retries it', async () => {
		makeFetch({ logsFailures: 1, logs: 'retried logs' });
		const user = userEvent.setup();
		renderPage('?job=job-1&run=run_01');

		await user.click(await screen.findByRole('tab', { name: 'Logs' }));
		expect(await screen.findByText('Failed to load run logs.')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Retry' }));
		expect(await screen.findByText('retried logs')).toBeInTheDocument();
	});

	it('hides mutations from viewers and disables the logs tab', async () => {
		makeFetch({ role: 'viewer' });
		renderPage('?job=job-1&run=run_01');

		await screen.findByRole('heading', { name: 'Nightly refresh' });
		expect(screen.queryByRole('button', { name: /New job/ })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Run now/ })).not.toBeInTheDocument();
		expect(await screen.findByRole('tab', { name: 'Logs' })).toBeDisabled();
	});

	it('runs a job now and selects the queued run', async () => {
		const world = makeFetch();
		const user = userEvent.setup();
		renderPage();

		await user.click(await screen.findByRole('button', { name: /Run now/ }));
		await waitFor(() =>
			expect(
				world.calls.some((c) => c.method === 'POST' && c.url.endsWith('/jobs/job-1/runs')),
			).toBe(true),
		);
		expect(
			await screen.findByText('Waiting for the scheduler to pick this run up.'),
		).toBeInTheDocument();
	});

	it('cancels an in-progress run after confirmation', async () => {
		const world = makeFetch({
			runs: [
				run({
					run_id: 'run_09',
					status: 'running',
					finished_at: undefined,
					exit_code: undefined,
					output: undefined,
				}),
			],
		});
		const user = userEvent.setup();
		renderPage('?job=job-1&run=run_09');

		await user.click(await screen.findByRole('button', { name: /Cancel run/ }));
		const dialog = await screen.findByRole('dialog');
		expect(
			within(dialog).getByText(/Any output captured before cancellation remains available/),
		).toBeInTheDocument();
		await user.click(within(dialog).getByRole('button', { name: 'Cancel run' }));
		await waitFor(() =>
			expect(
				world.calls.some((c) => c.method === 'POST' && c.url.endsWith('/runs/run_09/cancel')),
			).toBe(true),
		);
	});

	it('creates a job from the dialog with a parsed schedule and parameters', async () => {
		const world = makeFetch({ jobs: [] });
		const user = userEvent.setup();
		renderPage();

		expect(await screen.findByText('No jobs yet')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: /New job/ }));
		const dialog = await screen.findByRole('dialog');
		await user.type(within(dialog).getByLabelText('Name'), 'Weekly report');
		await user.click(within(dialog).getByRole('switch', { name: /Manual runs only/ }));
		const cron = within(dialog).getByLabelText(/Cron/);
		await user.clear(cron);
		await user.type(cron, '0 9 * * mon');
		const tz = within(dialog).getByLabelText(/Time zone/);
		await user.clear(tz);
		await user.type(tz, 'UTC');
		await user.type(within(dialog).getByLabelText('Parameters'), 'region=eu\nlimit=10');
		await user.click(within(dialog).getByRole('button', { name: 'Create job' }));

		await waitFor(() => {
			const create = world.calls.find((c) => c.method === 'POST' && c.url.endsWith('/jobs'));
			expect(create?.body).toEqual({
				name: 'Weekly report',
				enabled: true,
				schedule: { cron: '0 9 * * mon', timezone: 'UTC' },
				parameters: { region: 'eu', limit: '10' },
				concurrency_policy: 'forbid',
			});
		});
		expect(await screen.findByRole('heading', { name: 'Weekly report' })).toBeInTheDocument();
	});

	it('edits a job, clearing sections the form leaves empty', async () => {
		const world = makeFetch({
			jobs: [job({ parameters: { a: '1' }, retry: { max_retries: 2, backoff_seconds: 30 } })],
		});
		const user = userEvent.setup();
		renderPage();

		await user.click(await screen.findByRole('button', { name: /Edit/ }));
		const dialog = await screen.findByRole('dialog');
		await user.clear(within(dialog).getByLabelText('Parameters'));
		const retries = within(dialog).getByLabelText('Retries on failure');
		await user.clear(retries);
		await user.type(retries, '0');
		await user.click(within(dialog).getByRole('button', { name: 'Save' }));

		await waitFor(() => {
			const patch = world.calls.find((c) => c.method === 'PATCH');
			expect(patch?.body).toMatchObject({
				parameters: null,
				retry: null,
				schedule: { cron: '0 6 * * *' },
			});
		});
	});

	it('deletes a job after confirmation', async () => {
		const world = makeFetch();
		const user = userEvent.setup();
		renderPage();

		await user.click(await screen.findByRole('button', { name: /Delete/ }));
		const dialog = await screen.findByRole('dialog');
		await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
		await waitFor(() => {
			expect(world.calls.find((call) => call.method === 'DELETE')?.ifMatch).toBe(
				'2026-09-01T10:00:00Z',
			);
		});
		expect(await screen.findByText('No jobs yet')).toBeInTheDocument();
	});

	it('shows an error state when the job list cannot be loaded', async () => {
		makeFetch({ jobsError: true });
		renderPage();
		expect(await screen.findByText('Failed to load jobs.')).toBeInTheDocument();
	});

	it('falls back to the first job when the linked job no longer exists', async () => {
		makeFetch();
		renderPage('?job=job-gone');
		expect(await screen.findByRole('heading', { name: 'Nightly refresh' })).toBeInTheDocument();
	});

	it('shows a failed run’s sanitized error and its missing output', async () => {
		makeFetch({
			runs: [
				run({
					run_id: 'run_bad',
					status: 'failed',
					exit_code: 1,
					error: { code: 'NOTEBOOK_FAILED', message: 'One or more cells failed' },
					output: undefined,
				}),
			],
			html: null,
		});
		renderPage('?job=job-1&run=run_bad');
		expect(await screen.findByText('NOTEBOOK_FAILED')).toBeInTheDocument();
		expect(screen.getByText(/One or more cells failed/)).toBeInTheDocument();
		expect(await screen.findByText('This run produced no output.')).toBeInTheDocument();
		expect(screen.getByText('Exit 1')).toBeInTheDocument();
	});

	it('describes an in-progress run instead of loading output', async () => {
		const world = makeFetch({
			runs: [
				run({
					run_id: 'run_live',
					status: 'running',
					finished_at: undefined,
					exit_code: undefined,
					output: undefined,
				}),
			],
		});
		renderPage('?job=job-1&run=run_live');
		expect(await screen.findByText(/running in its own sandbox/)).toBeInTheDocument();
		expect(world.calls.some((c) => c.url.endsWith('/html'))).toBe(false);
	});

	it('does not describe or offer cancellation for an unknown run status', async () => {
		const world = makeFetch({
			runs: [
				run({
					run_id: 'run_future',
					status: 'unknown',
					finished_at: undefined,
					exit_code: undefined,
					output: undefined,
				}),
			],
		});
		renderPage('?job=job-1&run=run_future');

		expect(
			await screen.findByText(/status this version of marimohub does not recognize/),
		).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Cancel run/ })).not.toBeInTheDocument();
		expect(world.calls.some((call) => call.url.endsWith('/html'))).toBe(false);
	});

	it('does not label an unknown trigger as manual', async () => {
		makeFetch({
			runs: [run({ trigger: 'unknown', triggered_by: 'u-1' })],
		});
		renderPage('?job=job-1&run=run_01');

		expect(await screen.findByText('Run trigger not recognized')).toBeInTheDocument();
		expect(screen.queryByText(/Run manually/)).not.toBeInTheDocument();
	});

	it('toasts when a manual run is rejected', async () => {
		makeFetch({
			triggerError: jsonError('RESOURCE_EXHAUSTED', 'Too many queued runs for this job', 429),
		});
		const user = userEvent.setup();
		renderPage();
		await user.click(await screen.findByRole('button', { name: /Run now/ }));
		expect((await screen.findAllByText(/Too many queued runs/)).length).toBeGreaterThan(0);
	});

	it('shows the empty run history for a job that never ran', async () => {
		makeFetch({ runs: [] });
		renderPage();
		expect(await screen.findByText('No runs yet.')).toBeInTheDocument();
	});

	it('marks a disabled job in the list and offers to enable it', async () => {
		const world = makeFetch({ jobs: [job({ enabled: false })] });
		const user = userEvent.setup();
		renderPage();
		expect(await screen.findByText('Disabled')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Enable' }));
		await waitFor(() =>
			expect(world.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ enabled: true }),
		);
	});

	it('shows the image and compute profile a run provisioned with', async () => {
		makeFetch({
			runs: [run({ image: 'ghcr.io/org/gpu:1', compute_profile: 'large' })],
		});
		renderPage('?job=job-1&run=run_01');
		expect(await screen.findByText('Compute large')).toBeInTheDocument();
		expect(screen.getByTitle('ghcr.io/org/gpu:1')).toHaveTextContent('Image ghcr.io/org/gpu:1');
	});
});
