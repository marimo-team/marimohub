import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { VersionHistoryDialog } from './VersionHistoryDialog';
import type { NotebookEntry, NotebookVersion } from '@/types';

// The real diff pane pulls in @pierre/diffs (shadow DOM + shiki), which cannot
// run in jsdom. React.lazy's dynamic import resolves to this stub instead.
vi.mock('./VersionDiffView', () => ({
	default: ({ oldCode, newCode }: { oldCode: string; newCode: string }) => (
		<div data-testid="diff-view" data-old={oldCode} data-new={newCode} />
	),
}));

const PID = 'proj-1';
const NID = 'nb-1';

const notebook = (sourceType: 'local' | 'git' = 'local'): NotebookEntry =>
	({ id: NID, title: 'my_analysis', source_type: sourceType }) as NotebookEntry;

function version(id: string, savedAt: string, message: string): NotebookVersion {
	return {
		version_id: id,
		notebook_id: NID,
		saved_at: savedAt,
		author: 'u-1',
		message,
		parent_id: null,
	};
}

// Newest first, matching the API's order.
const VERSIONS = [
	version('v3', '2026-07-01T10:00:00Z', 'latest save'),
	version('v2', '2026-07-01T08:00:00Z', 'middle save'),
	version('v1', '2026-06-30T10:00:00Z', 'first save'),
];

const CODE: Record<string, string> = {
	v3: 'code of v3',
	v2: 'code of v2',
	v1: 'code of v1',
};

const DIRECTORY = { 'u-1': { id: 'u-1', email: 'ana@x.io', name: 'Ana Author' } };

function ok(data: unknown) {
	return new Response(JSON.stringify({ success: true, data }), {
		headers: { 'content-type': 'application/json' },
	});
}

function fail(status: number, message: string) {
	return new Response(JSON.stringify({ success: false, error: { code: 'ERR', message } }), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

/**
 * Route the dialog's requests to canned responses, recording every call so
 * tests can assert on ordering and payloads.
 */
function makeFetch({
	versions = VERSIONS,
	listResponse,
	restoreResponse,
	source = { type: 'local', current_version_id: 'v3' },
}: {
	versions?: NotebookVersion[];
	listResponse?: Response;
	restoreResponse?: Response;
	/** The notebook detail's source (git enables the per-version commit links). */
	source?: Record<string, unknown>;
} = {}) {
	const calls: { url: string; method: string }[] = [];
	const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? 'GET';
		calls.push({ url, method });

		if (method === 'POST' && url.includes('/restore'))
			return restoreResponse ?? ok({ id: NID, title: 'my_analysis' });
		const single = /\/versions\/(v\d+)$/.exec(url);
		if (single) {
			const v = versions.find((x) => x.version_id === single[1]);
			return ok({ version: v, code: CODE[single[1]] });
		}
		if (url.includes(`/notebooks/${NID}/versions`))
			return listResponse ?? ok({ items: versions, next_cursor: null });
		if (url.endsWith(`/notebooks/${NID}`))
			return ok({ meta: { id: NID, title: 'my_analysis', author: 'u-1' }, source });
		if (url.includes('/users')) return ok(DIRECTORY);
		throw new Error(`unexpected fetch: ${method} ${url}`);
	});
	vi.stubGlobal('fetch', impl);
	return calls;
}

const GIT_SOURCE = {
	type: 'git',
	repo: 'org/repo',
	branch: 'main',
	root_path: '',
	entry_notebook: 'app.py',
	commit: 'deadbeefcafe0123',
	current_version_id: 'v3',
	last_synced_at: '2026-07-01T10:00:00Z',
};

function renderDialog({
	sourceType = 'local' as const,
	canRestore = true,
}: { sourceType?: 'local' | 'git'; canRestore?: boolean } = {}) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const onClose = vi.fn();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			{children}
			<Toaster />
		</QueryClientProvider>
	);
	render(
		<VersionHistoryDialog
			isOpen
			onClose={onClose}
			projectId={PID}
			notebook={notebook(sourceType)}
			canRestore={canRestore}
		/>,
		{ wrapper },
	);
	return onClose;
}

/** The confirm dialog's own Restore button (row buttons are aria-hidden behind the modal). */
function confirmRestoreButton() {
	const dialog = screen.getByRole('dialog', { name: 'Restore Version' });
	return within(dialog).getByRole('button', { name: 'Restore' });
}

beforeEach(() => {
	// jsdom has no matchMedia; Tooltip's mobile check needs it.
	vi.stubGlobal('matchMedia', (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addEventListener: () => {},
		removeEventListener: () => {},
		addListener: () => {},
		removeListener: () => {},
		dispatchEvent: () => false,
	}));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('VersionHistoryDialog', () => {
	it('renders versions newest-first with a Current badge and resolved authors', async () => {
		makeFetch();
		renderDialog();

		const rows = await screen.findAllByTestId('version-row');
		expect(rows).toHaveLength(3);
		expect(within(rows[0]).getByText('Current')).toBeInTheDocument();
		expect(within(rows[0]).getByText('latest save')).toBeInTheDocument();
		expect(within(rows[2]).getByText('first save')).toBeInTheDocument();
		expect(within(rows[1]).queryByText('Current')).not.toBeInTheDocument();
		await waitFor(() => expect(within(rows[0]).getByText('Ana Author')).toBeInTheDocument());
	});

	it('links sync versions to their GitHub commits for a git-synced notebook', async () => {
		makeFetch({
			versions: [
				{
					...version('v2', '2026-07-01T10:00:00Z', 'Sync deadbeefcafe'),
					commit: 'deadbeefcafe0123',
				},
				// A version written before the commit field existed: parsed from the message.
				version('v1', '2026-06-30T10:00:00Z', 'Sync abc123def456'),
			],
			source: GIT_SOURCE,
		});
		renderDialog({ sourceType: 'git' });

		const stamped = await screen.findByRole('link', { name: 'deadbee' });
		expect(stamped).toHaveAttribute('href', 'https://github.com/org/repo/commit/deadbeefcafe0123');
		const legacy = screen.getByRole('link', { name: 'abc123d' });
		expect(legacy).toHaveAttribute('href', 'https://github.com/org/repo/commit/abc123def456');
	});

	it('shows no commit links for a local notebook', async () => {
		makeFetch();
		renderDialog();

		await screen.findAllByTestId('version-row');
		expect(screen.queryByTitle('View commit on GitHub')).toBeNull();
	});

	it('defaults the diff to previous → current', async () => {
		makeFetch();
		renderDialog();

		const diff = await screen.findByTestId('diff-view');
		expect(diff).toHaveAttribute('data-old', CODE.v2);
		expect(diff).toHaveAttribute('data-new', CODE.v3);
		expect(screen.getByRole('combobox', { name: 'Base version' })).toHaveValue('v2');
		expect(screen.getByRole('combobox', { name: 'Compare version' })).toHaveValue('v3');
	});

	it('re-diffs when the base select changes', async () => {
		const user = userEvent.setup();
		makeFetch();
		renderDialog();
		await screen.findByTestId('diff-view');

		await user.selectOptions(screen.getByRole('combobox', { name: 'Base version' }), 'v1');

		await waitFor(() =>
			expect(screen.getByTestId('diff-view')).toHaveAttribute('data-old', CODE.v1),
		);
		expect(screen.getByTestId('diff-view')).toHaveAttribute('data-new', CODE.v3);
	});

	it('clicking a row selects it as the base against Current', async () => {
		const user = userEvent.setup();
		makeFetch();
		renderDialog();
		await screen.findByTestId('diff-view');

		const rows = screen.getAllByTestId('version-row');
		await user.click(within(rows[2]).getByText('first save'));

		await waitFor(() =>
			expect(screen.getByTestId('diff-view')).toHaveAttribute('data-old', CODE.v1),
		);
		expect(screen.getByRole('combobox', { name: 'Base version' })).toHaveValue('v1');
		expect(screen.getByRole('combobox', { name: 'Compare version' })).toHaveValue('v3');
	});

	it('shows Restore only on non-current rows of restorable notebooks', async () => {
		makeFetch();
		renderDialog();

		const rows = await screen.findAllByTestId('version-row');
		expect(within(rows[0]).queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
		expect(within(rows[1]).getByRole('button', { name: 'Restore' })).toBeInTheDocument();
		expect(within(rows[2]).getByRole('button', { name: 'Restore' })).toBeInTheDocument();
	});

	it('hides Restore for git-synced notebooks', async () => {
		makeFetch();
		renderDialog({ sourceType: 'git' });
		await screen.findAllByTestId('version-row');
		expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
	});

	it('hides Restore when the viewer cannot restore', async () => {
		makeFetch();
		renderDialog({ canRestore: false });
		await screen.findAllByTestId('version-row');
		expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
	});

	it('restores through the confirm dialog and refetches the list', async () => {
		const user = userEvent.setup();
		const calls = makeFetch();
		renderDialog();
		const rows = await screen.findAllByTestId('version-row');

		await user.click(within(rows[1]).getByRole('button', { name: 'Restore' }));

		// Confirmation first — no POST yet, and the copy promises history is kept.
		expect(screen.getByText(/preserved as a version in history/)).toBeInTheDocument();
		expect(calls.some((c) => c.method === 'POST')).toBe(false);

		await user.click(confirmRestoreButton());

		await waitFor(() => {
			const post = calls.find((c) => c.method === 'POST');
			expect(post?.url).toContain(`/notebooks/${NID}/versions/v2/restore`);
		});
		// Invalidation re-fetches the version list.
		await waitFor(() => {
			const lists = calls.filter(
				(c) => c.method === 'GET' && c.url.split('?')[0]?.endsWith('/versions'),
			);
			expect(lists.length).toBeGreaterThan(1);
		});
		await screen.findByText('Version restored');
	});

	it('surfaces a restore failure and keeps the confirm dialog open', async () => {
		const user = userEvent.setup();
		makeFetch({ restoreResponse: fail(400, 'Cannot restore a version of a non-local notebook') });
		renderDialog();
		const rows = await screen.findAllByTestId('version-row');

		await user.click(within(rows[1]).getByRole('button', { name: 'Restore' }));
		await user.click(confirmRestoreButton());

		await screen.findByText(/non-local notebook/);
		expect(screen.getByText(/preserved as a version in history/)).toBeInTheDocument();
	});

	it('shows the empty state when there are no versions', async () => {
		makeFetch({ versions: [] });
		renderDialog();
		await screen.findByText('No versions yet');
	});

	it('shows a message instead of a diff for a single version', async () => {
		makeFetch({ versions: [VERSIONS[0]] });
		renderDialog();
		await screen.findByText('No previous versions to compare.');
		expect(screen.queryByTestId('diff-view')).not.toBeInTheDocument();
	});

	it('shows an error state with a working retry', async () => {
		const user = userEvent.setup();
		makeFetch({ listResponse: fail(500, 'boom') });
		renderDialog();

		await screen.findByText('Failed to load version history.');
		makeFetch(); // subsequent fetches succeed
		await user.click(screen.getByRole('button', { name: 'Retry' }));
		await screen.findAllByTestId('version-row');
	});
});
