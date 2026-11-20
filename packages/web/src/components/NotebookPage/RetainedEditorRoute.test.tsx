import { apiClient, ApiRequestError } from '@/api/client';
import { stopSessionSafely, SessionKeptRunningError } from '@/api/sessionStop';
import { deferred } from '@/test/deferred';
import type { Session } from '@/types';
import { RetainedEditorContext } from '@/context/RetainedEditorContext';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, useNavigate, useParams } from 'react-router-dom';
import { useContext, useEffect } from 'react';
import { EDITOR_RETENTION_MS, RetainedEditorRoute } from './RetainedEditorRoute';

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function TestNavigation() {
	const navigate = useNavigate();
	return (
		<>
			<button onClick={() => void navigate('/projects/p')}>Project</button>
			<button onClick={() => void navigate('/projects/p/notebooks/a')}>A</button>
			<button onClick={() => void navigate('/projects/p/notebooks/b')}>B</button>
			<button onClick={() => void navigate(-1)}>Back</button>
			<button onClick={() => void navigate('/projects/p/notebooks/a?tab=code#cell')}>Query</button>
		</>
	);
}

function setup(ready: boolean | ((notebookId: string | undefined) => boolean) = true) {
	const connected = vi.fn();
	const disconnected = vi.fn();
	function Editor() {
		const { nid } = useParams();
		const reportReady = useContext(RetainedEditorContext);
		const isReady = typeof ready === 'function' ? ready(nid) : ready;
		useEffect(
			() => reportReady?.(isReady ? `session-${nid}` : undefined),
			[reportReady, isReady, nid],
		);
		useEffect(() => {
			connected();
			return disconnected;
		}, []);
		return <iframe title={`editor-${nid}`} src="about:blank" />;
	}
	const viewFor = (userId: string) => (
		<MemoryRouter initialEntries={['/projects/p/notebooks/a']}>
			<TestNavigation />
			<RetainedEditorRoute key={userId} editor={<Editor />}>
				<p>Project content</p>
			</RetainedEditorRoute>
		</MemoryRouter>
	);
	const view = render(viewFor('first-user'));
	return {
		...view,
		connected,
		disconnected,
		changeUser: (userId: string) => view.rerender(viewFor(userId)),
	};
}

it('preserves the iframe across back navigation and suspends hidden effects', () => {
	const { connected, disconnected } = setup();
	const frame = screen.getByTitle('editor-a');
	fireEvent.click(screen.getByText('Project'));
	expect(frame).toBeInTheDocument();
	expect(frame).not.toBeVisible();
	expect(disconnected).toHaveBeenCalledOnce();
	fireEvent.click(screen.getByText('Back'));
	expect(screen.getByTitle('editor-a')).toBe(frame);
	expect(frame).toBeVisible();
	expect(connected).toHaveBeenCalledTimes(2);
});

it('does not retain an unfinished startup or failed editor', () => {
	setup(false);
	const frame = screen.getByTitle('editor-a');
	fireEvent.click(screen.getByText('Project'));
	expect(frame).not.toBeInTheDocument();
	fireEvent.click(screen.getByText('Back'));
	expect(screen.getByTitle('editor-a')).not.toBe(frame);
});

it('retains only one notebook and evicts inactive frames after the retention window', () => {
	vi.useFakeTimers();
	setup();
	const first = screen.getByTitle('editor-a');
	fireEvent.click(screen.getByText('B'));
	expect(first).not.toBeInTheDocument();
	const second = screen.getByTitle('editor-b');
	fireEvent.click(screen.getByText('Project'));
	act(() => {
		vi.advanceTimersByTime(EDITOR_RETENTION_MS);
	});
	expect(second).not.toBeInTheDocument();
	fireEvent.click(screen.getByText('Back'));
	expect(screen.getByTitle('editor-b')).not.toBe(second);
});

it('cancels eviction when the editor is reopened', () => {
	vi.useFakeTimers();
	setup();
	const frame = screen.getByTitle('editor-a');
	fireEvent.click(screen.getByText('Project'));
	act(() => {
		vi.advanceTimersByTime(EDITOR_RETENTION_MS / 2);
	});
	fireEvent.click(screen.getByText('Back'));
	act(() => {
		vi.advanceTimersByTime(EDITOR_RETENTION_MS);
	});
	expect(screen.getByTitle('editor-a')).toBe(frame);
});

it("does not reuse one notebook's readiness for a different unfinished editor", () => {
	setup((nid) => nid === 'a');
	fireEvent.click(screen.getByText('B'));
	const pending = screen.getByTitle('editor-b');
	fireEvent.click(screen.getByText('Project'));
	expect(pending).not.toBeInTheDocument();
});

it('evicts a hidden editor when the account changes', () => {
	const { changeUser } = setup();
	const previous = screen.getByTitle('editor-a');
	fireEvent.click(screen.getByText('Project'));
	expect(previous).toBeInTheDocument();
	changeUser('second-user');
	expect(previous).not.toBeInTheDocument();
	fireEvent.click(screen.getByText('A'));
	expect(screen.getByTitle('editor-a')).not.toBe(previous);
});

it('keeps the editor mounted when only query parameters or the hash change', () => {
	const { connected, disconnected } = setup();
	const frame = screen.getByTitle('editor-a');
	fireEvent.click(screen.getByText('Query'));
	expect(screen.getByTitle('editor-a')).toBe(frame);
	expect(connected).toHaveBeenCalledOnce();
	expect(disconnected).not.toHaveBeenCalled();
});

const stopResponse = (status = 200) =>
	({ data: { success: true }, response: new Response(null, { status }) }) as never;

const sessionResponse = (outcome: 'retained' | 'stopped') =>
	({
		data: {
			success: true,
			data: {
				session_id: 'session-a',
				status: outcome === 'stopped' ? 'terminated' : 'running',
				stop: { id: 'attempt', outcome },
			} as Session,
		},
		response: new Response(null, { status: 200 }),
	}) as never;

function hideEditor() {
	setup();
	const frame = screen.getByTitle('editor-a');
	fireEvent.click(screen.getByText('Project'));
	return frame;
}

it('evicts the hidden editor only after its session stops, then opens a fresh frame', async () => {
	const frame = hideEditor();
	const response = deferred<Awaited<ReturnType<typeof apiClient.DELETE>>>();
	vi.spyOn(apiClient, 'DELETE').mockReturnValue(response.promise);
	const stopping = stopSessionSafely('p', 'a', 'session-a');
	expect(frame).toBeInTheDocument();
	await act(async () => {
		response.resolve(stopResponse());
		await stopping;
	});
	expect(frame).not.toBeInTheDocument();
	fireEvent.click(screen.getByText('Back'));
	expect(screen.getByTitle('editor-a')).not.toBe(frame);
});

it.each([
	['other-project', 'a', 'session-a'],
	['p', 'b', 'session-b'],
	['p', 'a', 'app-session'],
])('preserves the editor when stopping %s/%s/%s', async (pid, nid, sid) => {
	const frame = hideEditor();
	vi.spyOn(apiClient, 'DELETE').mockResolvedValue(stopResponse());
	await act(async () => {
		await stopSessionSafely(pid, nid, sid);
	});
	expect(frame).toBeInTheDocument();
});

it('preserves the hidden editor when the session is kept running after a failed stop', async () => {
	const frame = hideEditor();
	vi.spyOn(apiClient, 'DELETE').mockRejectedValue(
		new ApiRequestError('SESSION_PERSISTENCE_REQUIRED', 'Retained', { status: 409 }),
	);
	vi.spyOn(apiClient, 'GET').mockResolvedValue(sessionResponse('retained'));
	await act(async () => {
		await expect(
			stopSessionSafely('p', 'a', 'session-a', async () => 'keep'),
		).rejects.toBeInstanceOf(SessionKeptRunningError);
	});
	expect(frame).toBeInTheDocument();
});

it('leaves the visible editor mounted for its own shutdown handling', async () => {
	setup();
	const frame = screen.getByTitle('editor-a');
	vi.spyOn(apiClient, 'DELETE').mockResolvedValue(stopResponse());
	await act(async () => {
		await stopSessionSafely('p', 'a', 'session-a');
	});
	expect(screen.getByTitle('editor-a')).toBe(frame);
});

it('evicts after reconciliation confirms an accepted stop', async () => {
	const frame = hideEditor();
	vi.spyOn(apiClient, 'DELETE').mockResolvedValue(stopResponse(202));
	vi.spyOn(apiClient, 'GET').mockResolvedValue(sessionResponse('stopped'));
	await act(async () => {
		await stopSessionSafely('p', 'a', 'session-a');
	});
	expect(frame).not.toBeInTheDocument();
});
