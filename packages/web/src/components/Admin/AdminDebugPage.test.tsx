import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { jsonOk, renderWithClient } from '@/test/render';
import type { SandboxStartupReport } from '@/types';
import AdminDebugPage from './AdminDebugPage';

const CAPABILITIES = {
	sandbox_images: ['registry.example/sandbox:default', 'registry.example/sandbox:py313'],
	sandbox_startup_timeout_seconds: 120,
	compute_profiles: [
		{ name: 'small', cpu: 1, memory_bytes: 2_147_483_648 },
		{ name: 'gpu', cpu: 8, memory_bytes: 34_359_738_368, gpu: 'A100' },
	],
};

function report(overrides: Partial<SandboxStartupReport> = {}): SandboxStartupReport {
	return {
		ok: true,
		sandbox_id: 'sb-first',
		image: 'registry.example/sandbox:py313',
		compute_profile: 'gpu',
		compute_resources: { cpu: 8, memory_bytes: 34_359_738_368, gpu: 'A100' },
		started_at: '2026-08-26T12:00:00.000Z',
		finished_at: '2026-08-26T12:00:02.000Z',
		total_ms: 2000,
		handle: { status: 'ok', duration_ms: 1 },
		readiness: {
			status: 'ok',
			duration_ms: 1800,
			command: 'echo "Hello"',
			stdout: 'Hello\n',
			stderr: '',
		},
		exec: {
			status: 'ok',
			duration_ms: 45,
			command: 'echo "Hello"',
			stdout: 'Hello\n',
			stderr: '',
		},
		cleanup: { status: 'ok', duration_ms: 154 },
		startup_timings_ms: { find: 4, create: 12, boot: 1700 },
		counters: { execs: 2 },
		environment_setup_benchmark: null,
		...overrides,
	};
}

function environmentSetupBenchmark(): NonNullable<
	SandboxStartupReport['environment_setup_benchmark']
> {
	return {
		tool: 'uv',
		runtime_probe: {
			status: 'ok',
			duration_ms: 30,
			command: 'uname -a',
			stdout: 'nproc=2\ncpu.max=200000 100000\n',
			stderr: '',
		},
		artifact_download: {
			status: 'ok',
			duration_ms: 1250,
			command: 'curl https://files.pythonhosted.org/botocore.whl',
			stdout: 'size_download=15313630\ntime_total=1.25\n',
			stderr: '',
		},
		prepare: {
			status: 'ok',
			duration_ms: 120,
			command: 'uv lock --no-cache',
			stdout: 'Resolved 15 packages in 120ms\n',
			stderr: '',
		},
		install: {
			status: 'ok',
			duration_ms: 9300,
			command: 'uv sync --frozen -v',
			stdout: 'Prepared 9 packages in 9.2s\nInstalled 9 packages in 80ms\n',
			stderr: '',
		},
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('AdminDebugPage', () => {
	it('submits selected options and renders the detailed startup report', async () => {
		const requests: { url: string; body?: string }[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				requests.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
				if (url === '/api/v1/capabilities') return jsonOk(CAPABILITIES);
				if (url === '/api/v1/admin/debug/sandbox-startup') {
					return jsonOk(report({ environment_setup_benchmark: environmentSetupBenchmark() }));
				}
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		const user = userEvent.setup();
		renderWithClient(<AdminDebugPage />);

		expect(
			await screen.findByRole('heading', { name: 'Sandbox startup time' }),
		).toBeInTheDocument();
		await user.click(await screen.findByRole('radio', { name: /py313/i }));
		await user.click(screen.getByRole('radio', { name: /gpu/i }));
		await user.click(
			screen.getByRole('switch', { name: /Fresh sandbox uv sync benchmark disabled/i }),
		);
		await user.click(screen.getByRole('button', { name: 'Run startup test' }));

		expect(await screen.findByRole('heading', { name: 'Latest report' })).toBeInTheDocument();
		expect(screen.getByText('sb-first')).toBeInTheDocument();
		expect(screen.getByText('Backend startup breakdown')).toBeInTheDocument();
		const bootTiming = screen.getByText('boot').parentElement;
		expect(bootTiming?.textContent?.replaceAll(/\D/g, '')).toBe('1700');
		expect(screen.getByText('Readiness (first echo)')).toBeInTheDocument();
		expect(screen.getByText('Single exec (second echo)')).toBeInTheDocument();
		expect(screen.getByText('Fresh sandbox uv sync benchmark')).toBeInTheDocument();
		expect(screen.getByText('Runtime and CPU limits')).toBeInTheDocument();
		expect(screen.getByText('uv sync (fresh sandbox)')).toBeInTheDocument();
		expect(screen.getByText(/Prepared 9 packages/)).toBeInTheDocument();
		expect(screen.getAllByText('Hello')).toHaveLength(2);
		expect(JSON.parse(requests.at(-1)?.body ?? '')).toEqual({
			image: 'registry.example/sandbox:py313',
			compute_profile: 'gpu',
			environment_setup_benchmark: true,
		});
	});

	it('uses adapter/platform defaults when no choices are configured', async () => {
		let submitted: unknown;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url === '/api/v1/capabilities') {
					return jsonOk({
						sandbox_images: [],
						sandbox_startup_timeout_seconds: 120,
						compute_profiles: [],
					});
				}
				if (url === '/api/v1/admin/debug/sandbox-startup') {
					submitted = JSON.parse(String(init?.body));
					return jsonOk(report({ image: null, compute_profile: null, compute_resources: {} }));
				}
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		const user = userEvent.setup();
		renderWithClient(<AdminDebugPage />);

		expect(await screen.findByRole('radio', { name: 'Adapter default' })).toBeChecked();
		expect(screen.getByRole('radio', { name: 'Platform default' })).toBeChecked();
		await user.click(screen.getByRole('button', { name: 'Run startup test' }));
		await screen.findByText('sb-first');
		expect(submitted).toEqual({});
	});

	it('submits a configured image whose name matches the default sentinel', async () => {
		let submitted: unknown;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url === '/api/v1/capabilities') {
					return jsonOk({ ...CAPABILITIES, sandbox_images: ['default'] });
				}
				if (url === '/api/v1/admin/debug/sandbox-startup') {
					submitted = JSON.parse(String(init?.body));
					return jsonOk(report({ image: 'default' }));
				}
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		const user = userEvent.setup();
		renderWithClient(<AdminDebugPage />);

		await user.click(await screen.findByRole('radio', { name: 'default' }));
		await user.click(screen.getByRole('button', { name: 'Run startup test' }));
		await screen.findByText('sb-first');
		expect(submitted).toEqual({ image: 'default' });
	});

	it('disables controls while a run is pending', async () => {
		let finish: ((response: Response) => void) | undefined;
		const pending = new Promise<Response>((resolve) => {
			finish = resolve;
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url === '/api/v1/capabilities') return jsonOk(CAPABILITIES);
				if (url === '/api/v1/admin/debug/sandbox-startup') return pending;
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		const user = userEvent.setup();
		renderWithClient(<AdminDebugPage />);

		const runButton = await screen.findByRole('button', { name: 'Run startup test' });
		await user.click(runButton);
		expect(await screen.findByRole('button', { name: 'Running…' })).toBeDisabled();
		expect(screen.getAllByRole('radio').every((radio) => radio.hasAttribute('disabled'))).toBe(
			true,
		);
		expect(screen.getByRole('switch')).toBeDisabled();
		finish?.(jsonOk(report()));
		await screen.findByText('sb-first');
	});

	it('renders partial failures and replaces the prior report on rerun', async () => {
		const failed = report({
			ok: false,
			sandbox_id: 'sb-failed',
			exec: {
				status: 'skipped',
				duration_ms: null,
				command: 'echo "Hello"',
				stdout: '',
				stderr: '',
			},
			cleanup: {
				status: 'failed',
				duration_ms: 50,
				error: { error_name: 'Error', error_code: 'BACKEND_UNAVAILABLE' },
			},
		});
		let calls = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url === '/api/v1/capabilities') return jsonOk(CAPABILITIES);
				if (url === '/api/v1/admin/debug/sandbox-startup') {
					calls++;
					return jsonOk(calls === 1 ? report() : failed);
				}
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		const user = userEvent.setup();
		renderWithClient(<AdminDebugPage />);

		const runButton = await screen.findByRole('button', { name: 'Run startup test' });
		await user.click(runButton);
		await screen.findByText('sb-first');
		await user.click(runButton);
		expect(await screen.findByText('sb-failed')).toBeInTheDocument();
		await waitFor(() => expect(screen.queryByText('sb-first')).not.toBeInTheDocument());
		expect(
			screen.getByText('Cleanup failed — the sandbox may still be running'),
		).toBeInTheDocument();
		expect(screen.getAllByText('Skipped')).toHaveLength(2);
		expect(screen.getByText(/BACKEND_UNAVAILABLE/)).toBeInTheDocument();
	});
});
