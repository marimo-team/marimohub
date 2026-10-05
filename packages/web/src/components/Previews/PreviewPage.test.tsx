import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { apiClient } from '@/api/client';
import { SESSION_LIFECYCLE_TIMEOUT_MS } from '@/api/hooks';
import { userKeys } from '@/api/queryKeys';
import { AuthProvider } from '@/context/AuthContext';
import { ThemeProvider } from '@/context/ThemeContext';
import { installMatchMedia, jsonError, jsonOk, renderWithClient } from '@/test/render';
import { PreviewPage } from './PreviewPage';

const route = '/projects/project/notebooks/notebook/previews/preview';
const endpoint = `/api/v1${route}`;
const storageKey = (userId: string) => `preview-session:${userId}:project:notebook:preview`;
const savedEditor = {
	userId: 'alice',
	nid: 'notebook',
	sid: 'alice-session',
	mode: 'edit',
	version: 'first-version',
};

type HeartbeatResponse =
	| 'running-without-url'
	| 'running'
	| 'starting'
	| 'terminated'
	| 'expired'
	| 'error'
	| 'terminating'
	| 'network'
	| number;
function setup({
	appUser = false,
	heartbeatIntervalSeconds = 30,
	heartbeat = 'running' as HeartbeatResponse,
	deleteStatus = 200,
	startupTimeoutSeconds = 120,
	pending = false,
} = {}) {
	let heartbeatResponse = heartbeat;
	let userId: string | null = 'alice';
	let version = 'first-version';
	let appStarts = 0;
	const calls: { url: string; method: string }[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? 'GET';
			calls.push({ url, method });
			if (url === '/api/v1/capabilities')
				return jsonOk({
					app_pool: { heartbeat_interval_seconds: heartbeatIntervalSeconds },
					sandbox_startup_timeout_seconds: startupTimeoutSeconds,
				});
			if (url === '/api/v1/me') return jsonOk({ id: userId, email: `${userId}@example.com` });
			if (url === endpoint) {
				return jsonOk({
					id: 'preview',
					name: 'Review preview',
					state: 'active',
					preparation: pending ? 'pending' : 'ready',
					source_type: 'branch',
					commit: pending ? null : version === 'first-version' ? 'a'.repeat(40) : 'b'.repeat(40),
					version_id: version,
					url: `https://hub.example.com${route}`,
					can: { app: true, edit: !appUser, manage: false },
				});
			}
			if (url === `${endpoint}/sessions`) {
				appStarts++;
				return jsonOk({
					notebook_id: 'notebook',
					session_id: appUser ? `${userId}-${version}-session` : `${userId}-session`,
					origin: {
						type: 'preview',
						notebook_id: 'notebook',
						preview_id: 'preview',
						revision_id: version,
						commit: 'a'.repeat(40),
					},
					...(appUser
						? {
								app_assignment: {
									visit_id: `visit-${version}${appStarts > 1 ? `-${appStarts}` : ''}`,
									generation: version,
								},
							}
						: {}),
					...(appUser ? {} : { user_id: userId, source_version_id: version }),
				});
			}
			if (url.includes('/sessions/')) {
				if (url.includes('/alice-session') && userId !== 'alice')
					return jsonError('FORBIDDEN', 'Another user owns this editor', 403);
				if (method === 'DELETE')
					return deleteStatus === 200
						? jsonOk(null)
						: jsonError('ERROR', 'Could not stop editor', deleteStatus);
				if (url.endsWith('/leave')) return jsonOk(null);
				if (url.endsWith('/heartbeat') || method === 'GET') {
					if (heartbeatResponse === 'network') throw new TypeError('Network unavailable');
					if (typeof heartbeatResponse === 'number')
						return jsonError('INTERNAL_ERROR', 'Heartbeat failed', heartbeatResponse);
					return jsonOk({
						status: heartbeatResponse === 'running-without-url' ? 'running' : heartbeatResponse,
						sandbox_url:
							heartbeatResponse === 'running-without-url'
								? undefined
								: `https://sandbox.example.com/${userId}/${url.includes('second-version-session') ? 'second' : 'first'}`,
					});
				}
			}
			throw new Error(`Unexpected request: ${method} ${url}`);
		}),
	);
	const view = renderWithClient(
		<AuthProvider>
			<ThemeProvider>
				<Routes>
					<Route
						path="/projects/:pid/notebooks/:nid/previews/:previewId"
						element={<PreviewPage />}
					/>
				</Routes>
			</ThemeProvider>
		</AuthProvider>,
		{ route, toaster: false },
	);
	return {
		...view,
		calls,
		setHeartbeatResponse(next: HeartbeatResponse) {
			heartbeatResponse = next;
		},
		async refetchHeartbeat(next: HeartbeatResponse) {
			heartbeatResponse = next;
			await act(async () => {
				await view.client.invalidateQueries({ queryKey: ['preview-session'] });
			});
		},
		async signIn(next: string | null) {
			userId = next;
			await act(async () => {
				view.client.setQueryData(
					userKeys.me(),
					next ? { id: next, email: `${next}@example.com` } : null,
				);
			});
		},
		async advanceBranch() {
			version = 'second-version';
			await act(async () => {
				await view.client.invalidateQueries({
					queryKey: ['preview', 'project', 'notebook', 'preview'],
				});
			});
		},
	};
}

beforeEach(() => {
	sessionStorage.clear();
	installMatchMedia();
});
afterEach(() => {
	sessionStorage.clear();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('PreviewPage', () => {
	it('restores only the current user’s editor and discards it before opening another', async () => {
		sessionStorage.setItem(storageKey('alice'), JSON.stringify(savedEditor));
		const { calls } = setup();
		const post = vi.spyOn(apiClient, 'POST');
		const remove = vi.spyOn(apiClient, 'DELETE');
		const user = userEvent.setup();
		expect(await screen.findByTitle('Review preview')).toHaveAttribute(
			'src',
			expect.stringContaining('/alice'),
		);
		await user.click(screen.getByRole('button', { name: 'Discard edits and open latest' }));
		await waitFor(() =>
			expect(calls).toContainEqual({ url: `${endpoint}/sessions`, method: 'POST' }),
		);
		expect(post).toHaveBeenCalledWith(
			'/api/v1/projects/{pid}/notebooks/{nid}/previews/{preview_id}/sessions',
			expect.objectContaining({ timeout: SESSION_LIFECYCLE_TIMEOUT_MS }),
		);
		expect(remove).toHaveBeenCalledWith(
			'/api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}',
			expect.objectContaining({ timeout: SESSION_LIFECYCLE_TIMEOUT_MS }),
		);
		const deletion = calls.findIndex((call) => call.method === 'DELETE');
		expect(calls[deletion].url).toContain('/alice-session');
		expect(deletion).toBeLessThan(calls.findIndex((call) => call.url === `${endpoint}/sessions`));
		expect(JSON.parse(sessionStorage.getItem(storageKey('alice'))!)).toMatchObject({
			userId: 'alice',
		});
	});

	it.each([403, 404, 409])(
		'opens another runtime after stale editor cleanup returns %s',
		async (deleteStatus) => {
			sessionStorage.setItem(storageKey('alice'), JSON.stringify(savedEditor));
			const { calls } = setup({ deleteStatus });
			const user = userEvent.setup();
			await screen.findByTitle('Review preview');
			await user.click(screen.getByRole('button', { name: 'Discard edits and open app' }));
			await waitFor(() =>
				expect(calls).toContainEqual({ url: `${endpoint}/sessions`, method: 'POST' }),
			);
			expect(screen.queryByText('Could not stop editor')).not.toBeInTheDocument();
		},
	);

	it('preserves the editor and reports nonterminal cleanup failures', async () => {
		sessionStorage.setItem(storageKey('alice'), JSON.stringify(savedEditor));
		const { calls } = setup({ deleteStatus: 503 });
		const user = userEvent.setup();
		await screen.findByTitle('Review preview');
		await user.click(screen.getByRole('button', { name: 'Discard edits and open app' }));
		expect(await screen.findByText('Could not stop editor')).toBeInTheDocument();
		expect(calls.some((call) => call.url === `${endpoint}/sessions`)).toBe(false);
		expect(screen.getByTitle('Review preview')).toBeInTheDocument();
	});

	it.each(['starting', 503] as const)(
		'bounds startup when heartbeats return %s and allows a fresh attempt',
		async (heartbeat) => {
			vi.useFakeTimers();
			const { calls, setHeartbeatResponse } = setup({
				appUser: true,
				heartbeat,
				startupTimeoutSeconds: 5,
			});

			await vi.waitFor(() =>
				expect(screen.getByRole('button', { name: 'Open app' })).toBeInTheDocument(),
			);
			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'Open app' }));
				await vi.advanceTimersByTimeAsync(1);
			});
			await vi.waitFor(() =>
				expect(calls.some((call) => call.url.endsWith('/heartbeat'))).toBe(true),
			);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(36_000);
			});
			expect(screen.getByText(/The preview did not start in time/)).toBeInTheDocument();
			expect(screen.queryByText('Starting preview…')).not.toBeInTheDocument();
			const count = calls.filter((call) => call.url.endsWith('/heartbeat')).length;
			await act(async () => {
				await vi.advanceTimersByTimeAsync(60_000);
			});
			expect(calls.filter((call) => call.url.endsWith('/heartbeat'))).toHaveLength(count);
			setHeartbeatResponse('running');
			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'Open latest app' }));
				await vi.advanceTimersByTimeAsync(1);
			});
			await vi.waitFor(() => expect(screen.getByTitle('Review preview')).toBeInTheDocument());
			expect(screen.queryByText(/The preview did not start in time/)).not.toBeInTheDocument();
		},
	);

	it('cancels the startup deadline once the runtime is running', async () => {
		vi.useFakeTimers();
		setup({ appUser: true, heartbeat: 'running', startupTimeoutSeconds: 5 });
		await vi.waitFor(() =>
			expect(screen.getByRole('button', { name: 'Open app' })).toBeInTheDocument(),
		);
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Open app' }));
			await vi.advanceTimersByTimeAsync(1);
		});
		await vi.waitFor(() => expect(screen.getByTitle('Review preview')).toBeInTheDocument());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(screen.getByTitle('Review preview')).toBeInTheDocument();
		expect(screen.queryByText(/The preview did not start in time/)).not.toBeInTheDocument();
	});

	it.each([false, true])(
		'resets the runtime on account changes (logout first: %s)',
		async (logout) => {
			sessionStorage.setItem(storageKey('alice'), JSON.stringify(savedEditor));
			const { calls, signIn } = setup();
			const user = userEvent.setup();
			await screen.findByTitle('Review preview');
			if (logout) {
				await signIn(null);
				await waitFor(() => expect(screen.queryByTitle('Review preview')).not.toBeInTheDocument());
			}
			await signIn('bob');
			await user.click(await screen.findByRole('button', { name: 'Open temporary editor' }));
			await waitFor(() => expect(sessionStorage.getItem(storageKey('bob'))).not.toBeNull());
			expect(calls.filter((call) => call.method === 'DELETE')).toEqual([]);
			expect(JSON.parse(sessionStorage.getItem(storageKey('bob'))!)).toMatchObject({
				userId: 'bob',
				sid: 'bob-session',
			});
			expect(screen.queryByRole('alert')).not.toBeInTheDocument();
		},
	);

	it.each(['legacy', 'foreign-owner', 'missing-owner'])(
		'ignores %s storage without deleting another user’s editor',
		async (kind) => {
			const key =
				kind === 'legacy' ? 'preview-session:project:notebook:preview' : storageKey('alice');
			const value = { ...savedEditor, userId: kind === 'missing-owner' ? undefined : 'bob' };
			sessionStorage.setItem(key, JSON.stringify(value));
			const { calls } = setup();
			const user = userEvent.setup();
			await user.click(await screen.findByRole('button', { name: 'Open temporary editor' }));
			await waitFor(() =>
				expect(calls).toContainEqual({ url: `${endpoint}/sessions`, method: 'POST' }),
			);
			expect(calls.filter((call) => call.method === 'DELETE')).toEqual([]);
		},
	);

	it('shows an updated revision to app-users while keeping their existing app open', async () => {
		const { advanceBranch, calls } = setup({ appUser: true });
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Open app' }));
		const frame = await screen.findByTitle('Review preview');
		expect(screen.queryByText(/A newer revision is available/)).not.toBeInTheDocument();
		await advanceBranch();
		expect(await screen.findByText(/A newer revision is available/)).toBeInTheDocument();
		expect(screen.getByTitle('Review preview')).toBe(frame);
		expect(sessionStorage.getItem(storageKey('alice'))).toBeNull();
		await user.click(screen.getByRole('button', { name: 'Open latest app' }));
		await waitFor(() =>
			expect(screen.queryByText(/A newer revision is available/)).not.toBeInTheDocument(),
		);
		await waitFor(() =>
			expect(screen.getByTitle('Review preview')).toHaveAttribute(
				'src',
				expect.stringContaining('/second'),
			),
		);
		expect(
			calls.some(
				(call) => call.url.includes('second-version-session') && call.url.endsWith('/heartbeat'),
			),
		).toBe(true);
		expect(
			calls.some(
				(call) => call.url.includes('first-version-session') && call.url.endsWith('/leave'),
			),
		).toBe(true);
	});
	it('releases app visits on pagehide and unmount, but retains them in the back-forward cache', async () => {
		const { unmount, calls } = setup({ appUser: true });
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Open app' }));
		await screen.findByTitle('Review preview');
		await act(async () =>
			window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
		);
		expect(calls.filter((call) => call.url.endsWith('/leave'))).toHaveLength(0);
		await act(async () =>
			window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })),
		);
		expect(calls.filter((call) => call.url.endsWith('/leave'))).toHaveLength(1);
		const leave = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/leave'));
		expect(leave?.[1]?.keepalive).toBe(true);
		expect(JSON.parse(String(leave?.[1]?.body))).toEqual({
			visit_id: 'visit-first-version',
			generation: 'first-version',
		});
		await act(async () => unmount());
		expect(calls.filter((call) => call.url.endsWith('/leave'))).toHaveLength(2);
		window.dispatchEvent(new PageTransitionEvent('pagehide'));
		expect(calls.filter((call) => call.url.endsWith('/leave'))).toHaveLength(2);
	});
	it('shows a first-revision fallback while preparation is pending', async () => {
		setup({ pending: true });
		expect(await screen.findByText('Awaiting first revision')).toBeVisible();
		expect(screen.queryByText(/Latest:/)).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Open app' })).toBeDisabled();
	});

	it('watches editor status every 30 seconds and renews it every two minutes', async () => {
		const { calls, refetchHeartbeat } = setup();
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Open temporary editor' }));
		await screen.findByTitle('Review preview');
		vi.useFakeTimers();
		const heartbeatCount = () => calls.filter((call) => call.url.endsWith('/heartbeat')).length;
		const statusCount = () =>
			calls.filter((call) => call.method === 'GET' && call.url.endsWith('/sessions/alice-session'))
				.length;
		await refetchHeartbeat('running');
		const initialStatuses = statusCount();
		const initialHeartbeats = heartbeatCount();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(90_000);
		});
		expect(heartbeatCount()).toBe(initialHeartbeats);
		expect(statusCount()).toBe(initialStatuses + 3);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30_000);
		});
		expect(heartbeatCount()).toBe(initialHeartbeats + 1);
		expect(statusCount()).toBe(initialStatuses + 3);
	});

	it('stops editor status checks after a running session loses its URL', async () => {
		const { calls, refetchHeartbeat, setHeartbeatResponse } = setup();
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Open temporary editor' }));
		await screen.findByTitle('Review preview');
		vi.useFakeTimers();
		await refetchHeartbeat('running');
		setHeartbeatResponse('running-without-url');
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30_001);
		});
		expect(screen.getByText(/This session has ended/)).toBeVisible();
		expect(screen.queryByTitle('Review preview')).not.toBeInTheDocument();
		const sessionCalls = () => calls.filter((call) => call.url.includes('/sessions/')).length;
		const count = sessionCalls();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(120_000);
		});
		expect(sessionCalls()).toBe(count);
	});

	it('renews app visits at the advertised interval', async () => {
		const { calls, refetchHeartbeat } = setup({ appUser: true, heartbeatIntervalSeconds: 2 });
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Open app' }));
		await screen.findByTitle('Review preview');
		vi.useFakeTimers();
		await refetchHeartbeat('running');
		const count = calls.filter((call) => call.url.endsWith('/heartbeat')).length;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1_999);
		});
		expect(calls.filter((call) => call.url.endsWith('/heartbeat'))).toHaveLength(count);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(calls.filter((call) => call.url.endsWith('/heartbeat'))).toHaveLength(count + 1);
	});

	it.each([500, 503, 'network'] as const)(
		'keeps a running preview visible and retries a transient %s heartbeat failure',
		async (failure) => {
			const { refetchHeartbeat, setHeartbeatResponse } = setup({
				appUser: true,
				heartbeatIntervalSeconds: 2,
			});
			const user = userEvent.setup();
			await user.click(await screen.findByRole('button', { name: 'Open app' }));
			const frame = await screen.findByTitle('Review preview');
			vi.useFakeTimers();
			await refetchHeartbeat(failure);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(1);
			});
			expect(screen.getByText('Unable to check the session. Retrying…')).toBeInTheDocument();
			expect(screen.getByTitle('Review preview')).toBe(frame);
			expect(screen.queryByText(/This session has ended/)).not.toBeInTheDocument();
			setHeartbeatResponse('running');
			await act(async () => {
				await vi.advanceTimersByTimeAsync(2_000);
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(1);
			});
			expect(screen.queryByText('Unable to check the session. Retrying…')).not.toBeInTheDocument();
			expect(screen.getByTitle('Review preview')).toBe(frame);
		},
	);

	it.each([
		403,
		404,
		409,
		'terminated',
		'expired',
		'error',
		'terminating',
		'running-without-url',
	] as const)('ends a preview after a confirmed %s heartbeat response', async (status) => {
		const { refetchHeartbeat, calls } = setup({ appUser: true });
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Open app' }));
		await screen.findByTitle('Review preview');
		await refetchHeartbeat(status);
		expect(await screen.findByText(/This session has ended/)).toBeInTheDocument();
		expect(screen.queryByTitle('Review preview')).not.toBeInTheDocument();
		vi.useFakeTimers();
		const count = calls.filter((call) => call.url.endsWith('/heartbeat')).length;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(calls.filter((call) => call.url.endsWith('/heartbeat'))).toHaveLength(count);
	});

	it('starts a fresh heartbeat after readmission to the same sandbox with a new visit', async () => {
		const { refetchHeartbeat, setHeartbeatResponse } = setup({ appUser: true });
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Open app' }));
		await screen.findByTitle('Review preview');
		await refetchHeartbeat(409);
		await screen.findByText(/This session has ended/);
		setHeartbeatResponse('running');
		await user.click(screen.getByRole('button', { name: 'Open latest app' }));
		expect(await screen.findByTitle('Review preview')).toBeInTheDocument();
		expect(screen.queryByText(/This session has ended/)).not.toBeInTheDocument();
	});

	it('keeps checking an admitted preview when its first heartbeat fails transiently', async () => {
		const { refetchHeartbeat } = setup({ appUser: true, heartbeat: 503 });
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Open app' }));
		expect(await screen.findByText('Unable to check the session. Retrying…')).toBeInTheDocument();
		expect(screen.getByText('Starting preview…')).toBeInTheDocument();
		expect(screen.queryByText(/Choose an app or temporary editor/)).not.toBeInTheDocument();
		await refetchHeartbeat('running');
		expect(await screen.findByTitle('Review preview')).toBeInTheDocument();
	});

	it('shows provisioning while an admitted app is still starting', async () => {
		const { refetchHeartbeat, client } = setup({ appUser: true, heartbeat: 'starting' });
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Open app' }));
		await waitFor(() =>
			expect(client.getQueriesData({ queryKey: ['preview-session'] })[0]?.[1]).toMatchObject({
				status: 'starting',
			}),
		);
		expect(screen.getByText('Starting preview…')).toBeInTheDocument();
		expect(screen.queryByText(/Choose an app or temporary editor/)).not.toBeInTheDocument();
		await refetchHeartbeat('running');
		expect(await screen.findByTitle('Review preview')).toBeInTheDocument();
	});
});
