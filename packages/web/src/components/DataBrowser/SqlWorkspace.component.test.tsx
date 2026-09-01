import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@/context/ThemeContext';
import { installMatchMedia, renderWithClient } from '@/test/render';
import SqlWorkspace from './SqlWorkspace';

const hookMocks = vi.hoisted(() => ({
	useUserQuery: vi.fn(),
	useDataQuerySchemaQuery: vi.fn(),
	useRunDataQuery: vi.fn(),
	useGenerateDataQuerySql: vi.fn(),
	executeQuery: vi.fn(),
	generateSql: vi.fn(),
}));

vi.mock('@/api/hooks', () => ({
	useUserQuery: hookMocks.useUserQuery,
	useDataQuerySchemaQuery: hookMocks.useDataQuerySchemaQuery,
	useRunDataQuery: hookMocks.useRunDataQuery,
	useGenerateDataQuerySql: hookMocks.useGenerateDataQuerySql,
}));

const STORAGE_KEY = 'marimohub:sql:user-1:project-1:integration-1';
const RESULT = {
	columns: ['value'],
	rows: [[1]],
	truncated: false,
	execution_ms: 3,
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function useRunDataQueryMock() {
	const [isPending, setPending] = useState(false);
	return {
		isPending,
		mutateAsync: async (input: { sql: string; signal: AbortSignal }) => {
			setPending(true);
			try {
				return await hookMocks.executeQuery(input);
			} finally {
				setPending(false);
			}
		},
	};
}

function workspaceElement() {
	return (
		<ThemeProvider>
			<SqlWorkspace
				projectId="project-1"
				integrationId="integration-1"
				integrationName="lake"
				selection={null}
				aiAvailable={false}
			/>
		</ThemeProvider>
	);
}

function renderWorkspace() {
	return renderWithClient(workspaceElement(), { toaster: false });
}

function storeDraft(draft: string) {
	localStorage.setItem(STORAGE_KEY, JSON.stringify({ draft, history: [] }));
}

beforeEach(() => {
	installMatchMedia();
	Object.defineProperty(Range.prototype, 'getClientRects', {
		configurable: true,
		value: () => [],
	});
	localStorage.clear();
	hookMocks.useUserQuery.mockReturnValue({ data: { id: 'user-1' } });
	hookMocks.useDataQuerySchemaQuery.mockReturnValue({
		isPending: false,
		isError: false,
		data: {
			tables: [],
			truncated: { tables: false, columns: false, bytes: false },
		},
	});
	hookMocks.useRunDataQuery.mockImplementation(useRunDataQueryMock);
	hookMocks.useGenerateDataQuerySql.mockReturnValue({
		isPending: false,
		mutateAsync: hookMocks.generateSql,
	});
});

afterEach(() => {
	localStorage.clear();
	delete (Range.prototype as Partial<Range>).getClientRects;
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

describe('SqlWorkspace', () => {
	it('runs the current statement and renders its result', async () => {
		storeDraft('SELECT 1 AS value;');
		hookMocks.executeQuery.mockResolvedValue(RESULT);
		const user = userEvent.setup();
		renderWorkspace();

		await user.click(screen.getByRole('button', { name: 'Run' }));

		await screen.findByRole('columnheader', { name: 'value' });
		expect(screen.getByRole('button', { name: '1' })).toHaveAttribute('title', 'Copy cell');
		expect(hookMocks.executeQuery).toHaveBeenCalledOnce();
		expect(hookMocks.executeQuery).toHaveBeenCalledWith({
			sql: 'SELECT 1 AS value',
			signal: expect.any(AbortSignal),
		});
	});

	it('keeps completed Run all results and stops after a middle statement fails', async () => {
		storeDraft('SELECT 1 AS value; SELECT broken; SELECT 3 AS value;');
		hookMocks.executeQuery
			.mockResolvedValueOnce(RESULT)
			.mockRejectedValueOnce(new Error('The second statement failed'));
		const user = userEvent.setup();
		renderWorkspace();

		await user.click(screen.getByRole('button', { name: 'Run all' }));

		await screen.findByText('The second statement failed');
		expect(screen.getByRole('columnheader', { name: 'value' })).toBeInTheDocument();
		expect(hookMocks.executeQuery).toHaveBeenCalledTimes(2);
		expect(hookMocks.executeQuery.mock.calls.map(([input]) => input.sql)).toEqual([
			'SELECT 1 AS value;',
			'SELECT broken;',
		]);
	});

	it('cancels an active run and suppresses its late result', async () => {
		storeDraft('SELECT 1 AS value;');
		const pending = deferred<typeof RESULT>();
		hookMocks.executeQuery.mockReturnValue(pending.promise);
		const user = userEvent.setup();
		renderWorkspace();

		await user.click(screen.getByRole('button', { name: 'Run' }));
		const cancel = await screen.findByRole('button', { name: 'Cancel' });
		const signal = hookMocks.executeQuery.mock.calls[0]?.[0].signal as AbortSignal;
		await user.click(cancel);
		expect(signal.aborted).toBe(true);

		pending.resolve(RESULT);
		await waitFor(() =>
			expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument(),
		);
		expect(screen.queryByRole('columnheader', { name: 'value' })).not.toBeInTheDocument();
		expect(screen.getByText('Run a query to see results.')).toBeInTheDocument();
	});

	it('renders a single fold gutter', async () => {
		const { container } = renderWorkspace();

		await waitFor(() => expect(container.querySelector('.cm-content')).toBeInTheDocument());
		expect(container.querySelectorAll('.cm-foldGutter')).toHaveLength(1);
	});

	it('runs the current statement on Mod-Enter despite basicSetup keybindings', async () => {
		storeDraft('SELECT 1 AS value;');
		hookMocks.executeQuery.mockResolvedValue(RESULT);
		const { container } = renderWorkspace();

		const content = await waitFor(() => {
			const element = container.querySelector('.cm-content');
			expect(element).toBeInTheDocument();
			return element as HTMLElement;
		});
		fireEvent.keyDown(content, { key: 'Enter', ctrlKey: true });

		await waitFor(() => expect(hookMocks.executeQuery).toHaveBeenCalledOnce());
		expect(hookMocks.executeQuery.mock.calls[0]?.[0].sql).toBe('SELECT 1 AS value');
	});

	it('keeps the editor mounted while completions refresh', async () => {
		storeDraft('SELECT 1 AS value;');
		hookMocks.useDataQuerySchemaQuery.mockReturnValue({
			isPending: false,
			isFetching: true,
			isError: false,
			data: { tables: [], truncated: { tables: false, columns: false, bytes: false } },
		});
		const { container } = renderWorkspace();

		await waitFor(() => expect(container.querySelector('.cm-content')).toBeInTheDocument());
		expect(screen.getByText('Updating completions…')).toBeInTheDocument();
	});

	it('preserves the editor instance when a table click refetches the schema', async () => {
		storeDraft('SELECT 1 AS value;');
		const view = renderWorkspace();
		const content = await waitFor(() => {
			const element = view.container.querySelector('.cm-content');
			expect(element).toBeInTheDocument();
			return element as HTMLElement;
		});

		hookMocks.useDataQuerySchemaQuery.mockReturnValue({
			isPending: false,
			isFetching: true,
			isError: false,
			data: {
				tables: [{ namespace: ['sales'], name: 'orders', columns: [{ name: 'id', type: 'long' }] }],
				truncated: { tables: false, columns: false, bytes: false },
			},
		});
		view.rerender(workspaceElement());

		await screen.findByText('Updating completions…');
		expect(view.container.querySelector('.cm-content')).toBe(content);
		expect(content).toHaveTextContent('SELECT 1 AS value;');
	});

	it('toggles fullscreen and exits on Escape', async () => {
		const user = userEvent.setup();
		renderWorkspace();

		await user.click(await screen.findByRole('button', { name: 'Fullscreen' }));
		expect(screen.getByRole('button', { name: 'Exit fullscreen' })).toBeInTheDocument();

		fireEvent.keyDown(window, { key: 'Escape' });

		expect(await screen.findByRole('button', { name: 'Fullscreen' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Exit fullscreen' })).not.toBeInTheDocument();
	});

	it('falls back to the last loaded schema when a refetch errors with no data', async () => {
		storeDraft('SELECT 1 AS value;');
		const view = renderWorkspace();
		const content = await waitFor(() => {
			const element = view.container.querySelector('.cm-content');
			expect(element).toBeInTheDocument();
			return element as HTMLElement;
		});

		hookMocks.useDataQuerySchemaQuery.mockReturnValue({
			isPending: false,
			isFetching: false,
			isError: true,
			error: new Error('schema fetch failed'),
			data: undefined,
		});
		view.rerender(workspaceElement());

		expect(view.container.querySelector('.cm-content')).toBe(content);
		expect(screen.getByText(/Couldn’t refresh completions/)).toBeInTheDocument();
		expect(screen.queryByText('SQL schema unavailable')).not.toBeInTheDocument();
	});

	it('keeps the editor mounted when a completions refresh fails', async () => {
		storeDraft('SELECT 1 AS value;');
		hookMocks.useDataQuerySchemaQuery.mockReturnValue({
			isPending: false,
			isFetching: false,
			isError: true,
			error: new Error('boom'),
			data: { tables: [], truncated: { tables: false, columns: false, bytes: false } },
		});
		const { container } = renderWorkspace();

		await waitFor(() => expect(container.querySelector('.cm-content')).toBeInTheDocument());
		expect(screen.getByText(/Couldn’t refresh completions/)).toBeInTheDocument();
		expect(screen.queryByText('SQL schema unavailable')).not.toBeInTheDocument();
	});

	it('blocks on the schema only for the very first load', () => {
		hookMocks.useDataQuerySchemaQuery.mockReturnValue({
			isPending: true,
			isFetching: true,
			isError: false,
			data: undefined,
		});
		const { container } = renderWorkspace();

		expect(container.querySelector('.cm-content')).not.toBeInTheDocument();
	});

	it('explains what a bounded completion schema loaded', async () => {
		hookMocks.useDataQuerySchemaQuery.mockReturnValue({
			isPending: false,
			isFetching: false,
			isError: false,
			data: {
				tables: [],
				truncated: { tables: true, columns: false, bytes: false },
				counts: { tables: 5, discovered_tables: 12, columns: 40, discovery_complete: false },
			},
		});
		const user = userEvent.setup();
		renderWorkspace();

		expect(
			screen.getByText('Completion schema is bounded; some tables or columns were omitted.'),
		).toBeInTheDocument();
		const trigger = screen.getByLabelText('Completion schema details');
		await user.hover(trigger);
		await screen.findByText(/Loaded 5 of 12\+ tables \(40 columns\)/, undefined, {
			timeout: 2_000,
		});
	});

	it('falls back to the default draft when persisted state is malformed', async () => {
		localStorage.setItem(STORAGE_KEY, '{not-json');
		hookMocks.executeQuery.mockResolvedValue(RESULT);
		const user = userEvent.setup();
		const { container } = renderWorkspace();

		await waitFor(() =>
			expect(container.querySelector('.cm-content')).toHaveTextContent('SELECT 1 AS ready;'),
		);
		await user.click(screen.getByRole('button', { name: 'Run' }));
		await screen.findByRole('columnheader', { name: 'value' });
		expect(hookMocks.executeQuery.mock.calls[0]?.[0].sql).toContain('SELECT 1 AS ready');
	});
});
