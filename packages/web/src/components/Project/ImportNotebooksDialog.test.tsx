import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';
import { renderWithClient, installMatchMedia } from '@/test/render';
import { notebookImports } from '@/api/notebookImports';
import { ApiRequestError } from '@/api/client';
import { formatAbsolute } from '@/lib/time';
import ImportNotebooksDialog from './ImportNotebooksDialog';
import {
	MAX_FOLDER_IMPORT_PATH_BYTES,
	MAX_FOLDER_IMPORT_SEGMENT_BYTES,
} from '@marimo-hub/core/workspace-ignore';
import { assertPreparedManifest, folderProblems, inspectFolder, packFolder } from './folderImport';

const defaultCapabilities = {
	sandbox_images: ['python:latest'],
	compute_profiles: [{ name: 'large' }],
	compute_profile_override: 'disabled',
};
const mocks = vi.hoisted(() => ({ capabilities: {} as Record<string, unknown> }));
vi.mock('@/api/hooks', () => ({
	useCapabilitiesQuery: () => ({ data: mocks.capabilities }),
}));
vi.mock('@/api/notebookImports', () => ({
	notebookImports: { prepare: vi.fn(), publish: vi.fn(), get: vi.fn() },
}));

type ImportOutcome = Awaited<ReturnType<typeof notebookImports.get>>['notebooks'][number];
const outcomes = (...notebooks: Partial<ImportOutcome>[]) =>
	({ id: 'imp-one', expires_at: '2026-10-08T12:00:00.000Z', notebooks }) as Awaited<
		ReturnType<typeof notebookImports.get>
	>;

function folderFile(path: string, text: string | Uint8Array = 'import marimo\n'): File {
	const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : new Uint8Array(text);
	const file = new File([bytes], path.split('/').at(-1)!);
	Object.defineProperty(file, 'webkitRelativePath', { value: `analysis/${path}` });
	file.arrayBuffer = async () => bytes.buffer;
	file.slice = () => ({ text: async () => new TextDecoder().decode(bytes) }) as Blob;
	return file;
}
const selectedFiles = () => [
	folderFile('a/revenue.py'),
	folderFile('b/revenue.py'),
	folderFile('shared/helpers.py', 'VALUE = 42'),
	folderFile('data/raw.bin', new Uint8Array([0, 255, 128])),
	folderFile('.env', 'TOKEN=secret'),
	folderFile('.git/config', 'git config'),
	folderFile('.python-version', '3.13'),
];

async function choose(files = selectedFiles()) {
	fireEvent.change(screen.getByLabelText('Choose folder', { selector: 'input' }), {
		target: { files },
	});
	await screen.findByRole('checkbox', { name: 'Import a/revenue.py' });
}

function renderDialog(onClose = vi.fn()) {
	return renderWithClient(
		<ImportNotebooksDialog projectId="proj-one" projectName="Sales" onClose={onClose} />,
		{ route: '/projects/proj-one' },
	);
}

const dismissButton = () =>
	within(screen.getByRole('heading', { name: 'Import notebooks' }).parentElement!).getByRole(
		'button',
		{ name: 'Close' },
	);
const footerCloseButton = () =>
	screen.getAllByRole('button', { name: 'Close' }).find((button) => button !== dismissButton())!;

async function startImportWithOneUnknown(user: ReturnType<typeof userEvent.setup>) {
	vi.mocked(notebookImports.publish).mockRejectedValueOnce(
		new ApiRequestError('NETWORK_ERROR', 'Connection lost'),
	);
	renderDialog();
	await choose();
	await user.click(screen.getByRole('button', { name: 'Import 2 notebooks' }));
	await screen.findByText('1 of 2 imported');
}

beforeEach(() => {
	installMatchMedia();
	mocks.capabilities = defaultCapabilities;
	vi.mocked(notebookImports.prepare).mockImplementation(async (_project, bytes) => ({
		id: 'imp-one',
		expires_at: '2026-10-08T12:00:00.000Z',
		files: Object.entries(unzipSync(bytes)).map(([path, content]) => ({
			path,
			size: content.length,
		})),
	}));
	vi.mocked(notebookImports.publish).mockImplementation(
		async (_project, _id, body) => ({ id: body.entry_notebook, title: body.title }) as never,
	);
	vi.mocked(notebookImports.get).mockResolvedValue(outcomes());
});
afterEach(() => vi.clearAllMocks());

describe('folder import review', () => {
	it.each([
		'Import expired; choose the folder again',
		'Import retry limit reached',
		'Import identity already has different notebook settings',
	])('does not retry a deterministic conflict: %s', async (message) => {
		vi.mocked(notebookImports.publish).mockRejectedValueOnce(
			new ApiRequestError('IMPORT_RESTART_REQUIRED', message, { status: 409 }),
		);
		const user = userEvent.setup();
		renderDialog();
		await choose();
		await user.click(screen.getByRole('button', { name: 'Import 2 notebooks' }));
		await screen.findByText('1 of 2 imported');
		expect(screen.getByText('Failed')).toBeInTheDocument();
		expect(screen.queryByText(/Outcome not confirmed/)).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /retry|Resume/i })).not.toBeInTheDocument();
		expect(notebookImports.get).not.toHaveBeenCalled();
		expect(notebookImports.publish).toHaveBeenCalledTimes(2);
	});

	it('keeps an in-progress conflict available for outcome reconciliation', async () => {
		vi.mocked(notebookImports.publish).mockRejectedValueOnce(
			new ApiRequestError('CONFLICT', 'Notebook import is still in progress', { status: 409 }),
		);
		const user = userEvent.setup();
		renderDialog();
		await choose();
		await user.click(screen.getByRole('button', { name: 'Import 2 notebooks' }));
		await screen.findByText('1 of 2 imported');
		expect(screen.getByText(/Outcome not confirmed/)).toBeInTheDocument();
		vi.mocked(notebookImports.get).mockResolvedValueOnce(
			outcomes({
				entry_notebook: 'a/revenue.py',
				state: 'complete',
				notebook: { id: 'reconciled' } as ImportOutcome['notebook'],
			}),
		);
		await user.click(screen.getByRole('button', { name: 'Check outcomes and retry' }));
		await screen.findByText('2 of 2 imported');
		expect(notebookImports.publish).toHaveBeenCalledTimes(2);
	});

	it('names result links with distinct notebook paths', async () => {
		const user = userEvent.setup();
		renderDialog();
		await choose();
		await user.click(screen.getByRole('button', { name: 'Import 2 notebooks' }));
		await screen.findByText('2 of 2 imported');
		for (const path of ['a/revenue.py', 'b/revenue.py']) {
			expect(screen.getByRole('link', { name: `View ${path} (opens in new tab)` })).toHaveAttribute(
				'href',
				`/projects/proj-one/notebooks/${path}`,
			);
		}
	});

	it('resets file review filters when choosing another folder with the same name', async () => {
		const user = userEvent.setup();
		renderDialog();
		await choose();
		await user.click(screen.getByText(/Included files:/));
		await user.type(
			screen.getByRole('textbox', { name: 'Filter included and excluded files' }),
			'.env',
		);
		await user.selectOptions(screen.getByRole('combobox', { name: 'Show files' }), 'excluded');
		fireEvent.change(screen.getByLabelText('Choose folder', { selector: 'input' }), {
			target: { files: [folderFile('new.py'), folderFile('data.csv', '1,2')] },
		});
		await screen.findByRole('checkbox', { name: 'Import new.py' });
		await user.click(screen.getByText(/Included files:/));
		expect(screen.getByRole('textbox', { name: 'Filter included and excluded files' })).toHaveValue(
			'',
		);
		expect(screen.getByRole('combobox', { name: 'Show files' })).toHaveValue('all');
		expect(screen.getByRole('checkbox', { name: 'Include data.csv' })).toBeInTheDocument();
	});

	it('distinguishes duplicate names, preserves unselected notebook files, and excludes credentials visibly', async () => {
		const user = userEvent.setup();
		renderDialog();
		await choose();
		expect(screen.getByRole('textbox', { name: 'Name for a/revenue.py' })).toHaveValue('revenue');
		expect(screen.getByRole('textbox', { name: 'Name for b/revenue.py' })).toHaveValue('revenue');
		await user.click(screen.getByRole('checkbox', { name: 'Import b/revenue.py' }));
		await user.click(screen.getByText(/Included files:/));
		expect(screen.getByRole('checkbox', { name: 'Include b/revenue.py' })).toBeChecked();
		expect(screen.getByRole('checkbox', { name: 'Include a/revenue.py' })).toBeDisabled();
		expect(screen.getByRole('checkbox', { name: 'Include .env' })).not.toBeChecked();
		expect(screen.getByRole('checkbox', { name: 'Include .git/config' })).toBeDisabled();
		await user.click(screen.getByText('Import settings'));
		expect(screen.queryByRole('combobox', { name: 'Compute profile' })).not.toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Import 1 notebook' }));
		await screen.findByText('1 of 1 imported');
		expect(notebookImports.prepare).toHaveBeenCalledTimes(1);
		const bytes = vi.mocked(notebookImports.prepare).mock.calls[0][1];
		const packed = unzipSync(bytes);
		expect(packed['b/revenue.py']).toBeDefined();
		expect(packed['data/raw.bin']).toEqual(new Uint8Array([0, 255, 128]));
		expect(packed['.env']).toBeUndefined();
		expect(packed['.python-version']).toBeDefined();
	});

	it('keeps successes and reconciles unknown outcomes before retrying only remaining identities', async () => {
		const user = userEvent.setup();
		await startImportWithOneUnknown(user);
		expect(screen.getByText('Outcome unknown')).toBeInTheDocument();
		vi.mocked(notebookImports.get).mockResolvedValueOnce(
			outcomes({
				entry_notebook: 'a/revenue.py',
				state: 'complete',
				notebook: { id: 'reconciled', title: 'Revenue' } as ImportOutcome['notebook'],
			}),
		);
		await user.click(screen.getByRole('button', { name: 'Check outcomes and retry' }));
		await screen.findByText('2 of 2 imported');
		expect(notebookImports.publish).toHaveBeenCalledTimes(2);
		expect(notebookImports.get).toHaveBeenCalledExactlyOnceWith('proj-one', 'imp-one');
		expect(notebookImports.prepare).toHaveBeenCalledTimes(1);
	});

	it('publishes an entry that is absent from the import outcome', async () => {
		const user = userEvent.setup();
		await startImportWithOneUnknown(user);
		vi.mocked(notebookImports.get).mockResolvedValueOnce(
			outcomes({ entry_notebook: 'b/revenue.py', state: 'complete' }),
		);
		await user.click(screen.getByRole('button', { name: 'Check outcomes and retry' }));
		await screen.findByText('2 of 2 imported');
		expect(notebookImports.publish).toHaveBeenCalledTimes(3);
		expect(vi.mocked(notebookImports.publish).mock.calls[2][2].entry_notebook).toBe('a/revenue.py');
	});

	it('stops dispatch after the active notebook completes', async () => {
		let finish!: (value: never) => void;
		vi.mocked(notebookImports.publish).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const user = userEvent.setup();
		const onClose = vi.fn();
		renderDialog(onClose);
		await choose();
		await user.click(screen.getByRole('button', { name: 'Import 2 notebooks' }));
		await waitFor(() => expect(notebookImports.publish).toHaveBeenCalledTimes(1));
		await user.keyboard('{Escape}');
		await user.click(dismissButton());
		expect(onClose).not.toHaveBeenCalled();
		expect(
			screen.queryByRole('dialog', { name: 'Leave unfinished import?' }),
		).not.toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Stop import' }));
		await act(async () => finish({ id: 'first', title: 'First' } as never));
		await screen.findByText('1 of 2 imported');
		expect(notebookImports.publish).toHaveBeenCalledTimes(1);
		expect(screen.getByText('Queued')).toBeInTheDocument();
		await user.click(footerCloseButton());
		const confirmation = await screen.findByRole('dialog', { name: 'Leave unfinished import?' });
		await user.click(within(confirmation).getByRole('button', { name: 'Cancel' }));
		await user.click(screen.getByRole('button', { name: 'Resume import' }));
		await screen.findByText('2 of 2 imported');
	});

	it('does not dispatch another notebook after navigating away', async () => {
		let finish!: (value: never) => void;
		vi.mocked(notebookImports.publish).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const user = userEvent.setup();
		const view = renderDialog();
		await choose();
		await user.click(screen.getByRole('button', { name: 'Import 2 notebooks' }));
		await waitFor(() => expect(notebookImports.publish).toHaveBeenCalledTimes(1));
		view.unmount();
		await act(async () => finish({ id: 'first', title: 'First' } as never));
		expect(notebookImports.publish).toHaveBeenCalledTimes(1);
	});
	it.each(['upload failure', 'manifest mismatch'])(
		'returns to review after %s and preserves edits',
		async (failure) => {
			if (failure === 'upload failure')
				vi.mocked(notebookImports.prepare).mockRejectedValueOnce(new Error('Upload failed'));
			else
				vi.mocked(notebookImports.prepare).mockResolvedValueOnce({
					id: 'bad',
					expires_at: '',
					files: [],
				});
			const user = userEvent.setup();
			renderDialog();
			await choose();
			const title = screen.getByRole('textbox', { name: 'Name for a/revenue.py' });
			await user.clear(title);
			await user.type(title, 'Custom name');
			await user.click(screen.getByRole('button', { name: 'Import 2 notebooks' }));
			await screen.findByRole('alert');
			expect(screen.getByRole('textbox', { name: 'Name for a/revenue.py' })).toHaveValue(
				'Custom name',
			);
			expect(notebookImports.publish).not.toHaveBeenCalled();
			await user.click(screen.getByRole('button', { name: 'Import 2 notebooks' }));
			await screen.findByText('2 of 2 imported');
		},
	);

	it('keeps successful links and does not retry expired entries', async () => {
		const user = userEvent.setup();
		await startImportWithOneUnknown(user);
		vi.mocked(notebookImports.get).mockResolvedValueOnce(
			outcomes({ entry_notebook: 'a/revenue.py', state: 'expired' }),
		);
		await user.click(screen.getByRole('button', { name: 'Check outcomes and retry' }));
		await screen.findByText('Expired');
		expect(screen.getByRole('link', { name: /View .+ \(opens in new tab\)/ })).toHaveAttribute(
			'target',
			'_blank',
		);
		expect(screen.queryByRole('button', { name: /retry|Resume/i })).not.toBeInTheDocument();
		expect(notebookImports.publish).toHaveBeenCalledTimes(2);
	});

	it('does not publish after stop while a status check is pending', async () => {
		const user = userEvent.setup();
		await startImportWithOneUnknown(user);
		let finish!: (value: ReturnType<typeof outcomes>) => void;
		vi.mocked(notebookImports.get).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await user.click(screen.getByRole('button', { name: 'Check outcomes and retry' }));
		await waitFor(() => expect(notebookImports.get).toHaveBeenCalledTimes(1));
		await user.click(screen.getByRole('button', { name: 'Stop import' }));
		expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
		await act(async () => finish(outcomes()));
		await screen.findByRole('button', { name: 'Resume import' });
		expect(notebookImports.publish).toHaveBeenCalledTimes(2);
	});

	it('waits for a pending server import and never publishes when status lookup fails', async () => {
		const user = userEvent.setup();
		await startImportWithOneUnknown(user);
		vi.mocked(notebookImports.get).mockResolvedValueOnce(
			outcomes({ entry_notebook: 'a/revenue.py', state: 'preparing' }),
		);
		await user.click(screen.getByRole('button', { name: 'Check outcomes and retry' }));
		const processing = await screen.findByText('Still processing. Check again shortly.');
		expect(processing).not.toHaveClass('text-destructive');
		vi.mocked(notebookImports.get).mockRejectedValueOnce(new Error('Status unavailable'));
		await user.click(screen.getByRole('button', { name: 'Check outcomes and retry' }));
		await screen.findByText(/Status unavailable/);
		expect(notebookImports.publish).toHaveBeenCalledTimes(2);
	});

	it('marks the import expired when the server has purged it', async () => {
		const user = userEvent.setup();
		await startImportWithOneUnknown(user);
		vi.mocked(notebookImports.get).mockRejectedValueOnce(
			new ApiRequestError('NOT_FOUND', 'Import not found', { status: 404 }),
		);
		await user.click(screen.getByRole('button', { name: 'Check outcomes and retry' }));
		await screen.findByText('This import has expired. Start a new import for this notebook.');
		expect(notebookImports.publish).toHaveBeenCalledTimes(2);
		expect(screen.queryByRole('button', { name: 'Check outcomes and retry' })).toBeNull();
	});

	it('selects search matches without excluding supporting files when selection is cleared', async () => {
		const user = userEvent.setup();
		renderDialog();
		await choose();
		await user.click(screen.getByRole('button', { name: 'Clear selection' }));
		await user.type(screen.getByRole('textbox', { name: 'Search notebook paths' }), 'a/');
		await user.click(screen.getByRole('button', { name: 'Select matching' }));
		await user.click(screen.getByText(/Included files:/));
		expect(screen.getByRole('checkbox', { name: 'Include b/revenue.py' })).toBeChecked();
		await user.selectOptions(screen.getByRole('combobox', { name: 'Show files' }), 'excluded');
		expect(screen.getByRole('checkbox', { name: 'Include .env' })).not.toBeChecked();
		expect(
			screen.queryByRole('checkbox', { name: 'Include b/revenue.py' }),
		).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Import 1 notebook' })).toBeEnabled();
	});
	it('continues after a rejected notebook and retries only the failed identity', async () => {
		vi.mocked(notebookImports.publish).mockRejectedValueOnce(
			new ApiRequestError('BAD_REQUEST', 'Temporary import rejection', { status: 400 }),
		);
		const user = userEvent.setup();
		renderDialog();
		await choose();
		await user.click(screen.getByRole('button', { name: 'Import 2 notebooks' }));
		await screen.findByText('1 of 2 imported');
		expect(screen.getByText('Failed')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Retry remaining' }));
		await screen.findByText('2 of 2 imported');
		expect(notebookImports.publish).toHaveBeenCalledTimes(3);
		expect(vi.mocked(notebookImports.publish).mock.calls[2]).toEqual(
			vi.mocked(notebookImports.publish).mock.calls[0],
		);
		expect(notebookImports.prepare).toHaveBeenCalledTimes(1);
	});

	it('shows the generated file allowance and blocks an over-capacity upload', async () => {
		const user = userEvent.setup();
		renderDialog();
		await choose([
			folderFile('a/revenue.py'),
			...Array.from({ length: 999 }, (_, index) => folderFile(`data/${index}.txt`, 'x')),
		]);
		await user.click(screen.getByText(/Included files:/));
		expect(screen.getByText(/Limits: 999 included files/)).toBeInTheDocument();
		expect(screen.getByText(/An empty pyproject.toml will be added/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Import 1 notebook' })).toBeDisabled();
		await user.click(screen.getByRole('checkbox', { name: 'Include data/0.txt' }));
		expect(screen.getByRole('button', { name: 'Import 1 notebook' })).toBeEnabled();
		expect(notebookImports.prepare).not.toHaveBeenCalled();
	});

	it('bounds notebook rows while preserving edits and selecting across pages', async () => {
		const user = userEvent.setup();
		renderDialog();
		await choose([
			folderFile('a/revenue.py'),
			...Array.from({ length: 105 }, (_, index) =>
				folderFile(`reports/report-${String(index).padStart(3, '0')}.py`),
			),
		]);
		expect(screen.getAllByRole('textbox', { name: /^Name for / })).toHaveLength(100);
		const title = screen.getByRole('textbox', { name: 'Name for a/revenue.py' });
		await user.clear(title);
		await user.type(title, 'Quarterly revenue');
		await user.click(screen.getByRole('button', { name: 'Next notebooks' }));
		expect(screen.getAllByRole('textbox', { name: /^Name for / })).toHaveLength(6);
		await user.click(screen.getByRole('checkbox', { name: 'Import reports/report-104.py' }));
		await user.click(screen.getByRole('button', { name: 'Previous notebooks' }));
		expect(screen.getByRole('textbox', { name: 'Name for a/revenue.py' })).toHaveValue(
			'Quarterly revenue',
		);
		await user.click(screen.getByRole('button', { name: 'Next notebooks' }));
		await user.type(screen.getByRole('textbox', { name: 'Search notebook paths' }), 'a/');
		expect(screen.getAllByRole('textbox', { name: /^Name for / })).toHaveLength(1);
		expect(screen.queryByRole('button', { name: 'Next notebooks' })).not.toBeInTheDocument();
		await user.clear(screen.getByRole('textbox', { name: 'Search notebook paths' }));
		await user.click(screen.getByRole('button', { name: 'Clear selection' }));
		await user.click(screen.getByRole('button', { name: 'Select matching' }));
		expect(screen.getByRole('button', { name: 'Import 106 notebooks' })).toBeEnabled();
		await user.click(screen.getByRole('button', { name: 'Next notebooks' }));
		expect(screen.getByRole('checkbox', { name: 'Import reports/report-104.py' })).toBeChecked();
		await user.click(screen.getByRole('button', { name: 'Import 106 notebooks' }));
		await screen.findByText('106 of 106 imported');
		expect(screen.getAllByRole('link', { name: /View .+ \(opens in new tab\)/ })).toHaveLength(100);
		await user.click(screen.getByRole('button', { name: 'Next notebooks' }));
		expect(screen.getAllByRole('link', { name: /View .+ \(opens in new tab\)/ })).toHaveLength(6);
		expect(notebookImports.publish).toHaveBeenCalledTimes(106);
	});

	it.each(['footer', 'dismiss', 'escape', 'backdrop'])(
		'confirms abandoning retry state through %s and can cancel without losing it',
		async (method) => {
			vi.mocked(notebookImports.publish).mockRejectedValueOnce(
				new ApiRequestError('NETWORK_ERROR', 'Connection lost'),
			);
			const user = userEvent.setup();
			const onClose = vi.fn();
			renderDialog(onClose);
			await choose();
			await user.click(screen.getByRole('button', { name: 'Import 2 notebooks' }));
			await screen.findByText('1 of 2 imported');
			if (method === 'escape') await user.keyboard('{Escape}');
			else if (method === 'backdrop') {
				const overlay = screen.getByRole('dialog').parentElement!.parentElement!;
				await user.click(overlay);
			} else await user.click(method === 'dismiss' ? dismissButton() : footerCloseButton());
			let confirmation = await screen.findByRole('dialog', { name: 'Leave unfinished import?' });
			expect(onClose).not.toHaveBeenCalled();
			await user.click(within(confirmation).getByRole('button', { name: 'Cancel' }));
			expect(screen.getByRole('button', { name: 'Check outcomes and retry' })).toBeEnabled();
			expect(screen.getByRole('link', { name: /View .+ \(opens in new tab\)/ })).toHaveAttribute(
				'target',
				'_blank',
			);
			await user.click(footerCloseButton());
			confirmation = await screen.findByRole('dialog', { name: 'Leave unfinished import?' });
			await user.click(within(confirmation).getByRole('button', { name: 'Leave import' }));
			expect(onClose).toHaveBeenCalledOnce();
		},
	);

	it('closes a completed import without an abandonment confirmation', async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		renderDialog(onClose);
		await choose();
		await user.click(screen.getByRole('button', { name: 'Import 2 notebooks' }));
		await screen.findByText('2 of 2 imported');
		await user.click(screen.getByRole('button', { name: 'View notebooks' }));
		expect(onClose).toHaveBeenCalledOnce();
		expect(
			screen.queryByRole('dialog', { name: 'Leave unfinished import?' }),
		).not.toBeInTheDocument();
	});

	it('bounds file rows and resets pagination when filtering', async () => {
		const user = userEvent.setup();
		renderDialog();
		await choose([
			...selectedFiles(),
			...Array.from({ length: 105 }, (_, index) =>
				folderFile(`data/file-${String(index).padStart(3, '0')}.bin`, 'x'),
			),
		]);
		expect(screen.queryByRole('checkbox', { name: /^Include / })).not.toBeInTheDocument();
		await user.click(screen.getByText(/Included files:/));
		expect(screen.getAllByRole('checkbox', { name: /^Include / })).toHaveLength(100);
		await user.click(screen.getByRole('button', { name: 'Next files' }));
		expect(screen.getByRole('checkbox', { name: 'Include data/file-104.bin' })).toBeInTheDocument();
		await user.type(
			screen.getByRole('textbox', { name: 'Filter included and excluded files' }),
			'.env',
		);
		expect(screen.getAllByRole('checkbox', { name: /^Include / })).toHaveLength(1);
		expect(screen.getByRole('checkbox', { name: 'Include .env' })).not.toBeChecked();
		expect(screen.queryByRole('button', { name: 'Next files' })).not.toBeInTheDocument();
	});
});

describe('folder import edge cases', () => {
	function pendingPrepare() {
		let signal: AbortSignal | undefined;
		vi.mocked(notebookImports.prepare).mockImplementationOnce(
			(_project, _bytes, abort) =>
				new Promise((_resolve, reject) => {
					signal = abort;
					abort?.addEventListener('abort', () => reject(new Error('aborted')));
				}),
		);
		return () => signal;
	}

	it('aborts the upload when stopped and returns to review without an error', async () => {
		const signal = pendingPrepare();
		const user = userEvent.setup();
		renderDialog();
		await choose();
		await user.click(screen.getByRole('button', { name: 'Import 2 notebooks' }));
		await waitFor(() => expect(notebookImports.prepare).toHaveBeenCalledOnce());
		await user.click(screen.getByRole('button', { name: 'Stop import' }));
		expect(signal()?.aborted).toBe(true);
		expect(await screen.findByRole('button', { name: 'Import 2 notebooks' })).toBeEnabled();
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
		expect(notebookImports.publish).not.toHaveBeenCalled();
	});

	it('aborts the upload when the dialog unmounts', async () => {
		const signal = pendingPrepare();
		const user = userEvent.setup();
		const view = renderDialog();
		await choose();
		await user.click(screen.getByRole('button', { name: 'Import 2 notebooks' }));
		await waitFor(() => expect(notebookImports.prepare).toHaveBeenCalledOnce());
		view.unmount();
		expect(signal()?.aborted).toBe(true);
	});

	it('reports an empty folder', async () => {
		renderDialog();
		fireEvent.change(screen.getByLabelText('Choose folder', { selector: 'input' }), {
			target: { files: [] },
		});
		expect(await screen.findByRole('alert')).toHaveTextContent('This folder has no files.');
	});

	it('requires relative paths from a folder picker', async () => {
		const file = new File(['import marimo'], 'loose.py');
		Object.defineProperty(file, 'webkitRelativePath', { value: '' });
		renderDialog();
		fireEvent.change(screen.getByLabelText('Choose folder', { selector: 'input' }), {
			target: { files: [file] },
		});
		expect(await screen.findByRole('alert')).toHaveTextContent(
			'Choose a folder so relative paths can be preserved.',
		);
	});

	it('explains a folder without notebooks and disables import', async () => {
		renderDialog();
		fireEvent.change(screen.getByLabelText('Choose folder', { selector: 'input' }), {
			target: { files: [folderFile('data.csv', '1,2')] },
		});
		expect(await screen.findByText(/No supported notebooks found/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /^Import\s+notebooks$/ })).toBeDisabled();
	});

	it('passes the chosen base image and compute profile to every publish', async () => {
		mocks.capabilities = { ...defaultCapabilities, compute_profile_override: 'editors' };
		const user = userEvent.setup();
		renderDialog();
		await choose();
		await user.click(screen.getByText('Import settings'));
		await user.selectOptions(screen.getByRole('combobox', { name: 'Base image' }), 'python:latest');
		await user.selectOptions(screen.getByRole('combobox', { name: 'Compute profile' }), 'large');
		await user.click(screen.getByRole('button', { name: 'Import 2 notebooks' }));
		await screen.findByText('2 of 2 imported');
		for (const [, , body] of vi.mocked(notebookImports.publish).mock.calls) {
			expect(body).toMatchObject({ base_image: 'python:latest', compute_profile: 'large' });
		}
	});

	it('excludes every unselected file matching the filter', async () => {
		const user = userEvent.setup();
		renderDialog();
		await choose();
		await user.click(screen.getByText(/Included files:/));
		await user.type(
			screen.getByRole('textbox', { name: 'Filter included and excluded files' }),
			'revenue',
		);
		expect(screen.getByRole('button', { name: 'Exclude matching' })).toBeDisabled();
		await user.clear(screen.getByRole('textbox', { name: 'Filter included and excluded files' }));
		await user.type(
			screen.getByRole('textbox', { name: 'Filter included and excluded files' }),
			'.p',
		);
		await user.click(screen.getByRole('button', { name: 'Exclude matching' }));
		expect(screen.getByRole('checkbox', { name: 'Include shared/helpers.py' })).not.toBeChecked();
		expect(screen.getByRole('checkbox', { name: 'Include .python-version' })).not.toBeChecked();
		expect(screen.getByRole('checkbox', { name: 'Include a/revenue.py' })).toBeChecked();
		await user.click(screen.getByRole('button', { name: 'Import 2 notebooks' }));
		await screen.findByText('2 of 2 imported');
		const packed = unzipSync(vi.mocked(notebookImports.prepare).mock.calls[0][1]);
		expect(Object.keys(packed).sort()).toEqual(['a/revenue.py', 'b/revenue.py', 'data/raw.bin']);
	});

	it('does not select credential-like notebooks in bulk', async () => {
		const user = userEvent.setup();
		renderDialog();
		await choose([...selectedFiles(), folderFile('.env.py')]);
		const sensitive = screen.getByRole('checkbox', { name: 'Import .env.py' });
		expect(sensitive).not.toBeChecked();
		await user.click(screen.getByRole('button', { name: 'Clear selection' }));
		await user.click(screen.getByRole('button', { name: 'Select matching' }));
		expect(sensitive).not.toBeChecked();
		expect(screen.getByRole('checkbox', { name: 'Import a/revenue.py' })).toBeChecked();
		await user.click(sensitive);
		expect(sensitive).toBeChecked();
	});

	it('describes why an invalid notebook cannot be selected', async () => {
		renderDialog();
		await choose([...selectedFiles(), folderFile('.marimohub-directory/notes.py')]);
		const checkbox = screen.getByRole('checkbox', { name: 'Import .marimohub-directory/notes.py' });
		expect(checkbox).toBeDisabled();
		expect(checkbox).toHaveAccessibleDescription(/\S/);
	});

	it('shows when the upload expires from the server response', async () => {
		const user = userEvent.setup();
		await startImportWithOneUnknown(user);
		expect(
			screen.getByText(
				new RegExp(`retry this upload until ${formatAbsolute('2026-10-08T12:00:00.000Z')}`),
			),
		).toBeInTheDocument();
	});
});

describe('folder validation', () => {
	it.each(['inspect', 'pack'] as const)(
		'%s bounds concurrent reads and preserves file identities when they finish out of order',
		async (operation) => {
			const originals = Array.from({ length: 10 }, (_, index) =>
				folderFile(`notebook-${index}.py`, `import marimo\nvalue = ${index}`),
			);
			const folder = await inspectFolder(originals);
			const started: number[] = [];
			let active = 0;
			let peak = 0;
			const releases: (() => void)[] = [];
			for (const [index, file] of originals.entries()) {
				const gate = new Promise<void>((resolve) => {
					releases[index] = resolve;
				});
				const read = async () => {
					started.push(index);
					active++;
					peak = Math.max(peak, active);
					await gate;
					active--;
					return `import marimo\nvalue = ${index}`;
				};
				if (operation === 'inspect') file.slice = () => ({ text: read }) as unknown as Blob;
				else file.arrayBuffer = async () => new TextEncoder().encode(await read()).buffer;
			}
			const pending = operation === 'inspect' ? inspectFolder(originals) : packFolder(folder.files);
			await waitFor(() => expect(started).toHaveLength(8));
			releases[7]();
			await waitFor(() => expect(started).toHaveLength(9));
			releases[8]();
			await waitFor(() => expect(started).toHaveLength(10));
			for (const release of releases) release();
			const result = await pending;
			expect(peak).toBe(8);
			if (result instanceof Uint8Array) {
				const unpacked = unzipSync(result);
				for (const [index, file] of folder.files.entries()) {
					expect(new TextDecoder().decode(unpacked[file.path])).toBe(
						`import marimo\nvalue = ${index}`,
					);
				}
			} else {
				expect(result.files.map((file) => file.path)).toEqual(
					folder.files.map((file) => file.path),
				);
				expect(result.files.every((file) => file.selected)).toBe(true);
			}
		},
	);

	it('detects duplicate paths before their concurrent reads finish', async () => {
		const folder = await inspectFolder([folderFile('same.py'), folderFile('same.py')]);
		expect(folder.files[0].selected).toBe(true);
		expect(folder.files[1].error).toBe('Invalid or duplicate folder path');
		expect(folderProblems(folder.files)).toHaveLength(1);
	});

	it('counts only an included root pyproject.toml toward the upload allowance', async () => {
		const supportingFiles = Array.from({ length: 999 }, (_, index) =>
			folderFile(`data/${index}.txt`, 'x'),
		);
		const folder = await inspectFolder([folderFile('a/revenue.py'), ...supportingFiles]);
		expect(folderProblems(folder.files)).toContain(
			'Include at most 999 files. One slot is reserved for generated pyproject.toml.',
		);
		expect(folderProblems(folder.files.slice(0, 999))).toEqual([]);
		const rootConfig = (await inspectFolder([folderFile('pyproject.toml', '')])).files[0];
		const atCapacity = [...folder.files.slice(0, 999), rootConfig];
		expect(folderProblems(atCapacity)).toEqual([]);
		expect(folderProblems([...folder.files, { ...rootConfig, included: false }])).toHaveLength(1);
		expect(
			folderProblems([
				...folder.files.slice(0, 999),
				{ ...rootConfig, path: 'nested/pyproject.toml' },
			]),
		).toHaveLength(1);
	});

	it('round trips binary and Unicode paths without flattening', async () => {
		const original = [folderFile('données/raw.bin', new Uint8Array([255, 0, 128]))];
		const folder = await inspectFolder(original);
		expect(unzipSync(await packFolder(folder.files))['données/raw.bin']).toEqual(
			new Uint8Array([255, 0, 128]),
		);
	});
	it('blocks oversize and unsafe paths before uploading', async () => {
		const file = folderFile('big.bin', 'x');
		Object.defineProperty(file, 'size', { value: 26 * 1024 * 1024 });
		const folder = await inspectFolder([file, folderFile('../escape.py')]);
		expect(folderProblems(folder.files)).toEqual(
			expect.arrayContaining(['big.bin exceeds 25 MiB.', expect.stringContaining('../escape.py:')]),
		);
	});
	it.each([
		'.marimohub-directory',
		'data/.marimohub-directory/file.txt',
		'pyproject.toml/config.txt',
		'PYPROJECT.TOML/config.txt',
		`${'é'.repeat(511)}.py`,
	])('rejects server-reserved or overlong path %s before uploading', async (path) => {
		const folder = await inspectFolder([folderFile(path)]);
		expect(folderProblems(folder.files)).toHaveLength(1);
		expect(folder.files[0].selected).toBe(false);
	});

	it('blocks a selection over the total size limit', async () => {
		const files = Array.from({ length: 5 }, (_, index) => {
			const file = folderFile(`data/${index}.bin`, 'x');
			Object.defineProperty(file, 'size', { value: 21 * 1024 * 1024 });
			return file;
		});
		const folder = await inspectFolder(files);
		expect(folderProblems(folder.files)).toEqual(['Included files exceed 100 MiB.']);
		expect(folderProblems(folder.files.slice(0, 4))).toEqual([]);
	});

	it('excludes virtualenvs the server would reject', async () => {
		const folder = await inspectFolder([
			folderFile('app.py'),
			folderFile('venv/pyvenv.cfg', 'home = /usr/bin'),
			folderFile('venv/bin/activate.py'),
			folderFile('vendor/lib/site-packages/marimo/__init__.py'),
		]);
		const byPath = Object.fromEntries(folder.files.map((file) => [file.path, file]));
		for (const path of [
			'venv/pyvenv.cfg',
			'venv/bin/activate.py',
			'vendor/lib/site-packages/marimo/__init__.py',
		]) {
			expect(byPath[path]).toMatchObject({
				exclusion: 'generated',
				included: false,
				candidate: false,
			});
		}
		expect(byPath['app.py']).toMatchObject({ included: true, selected: true });
	});

	it('excludes everything when the chosen folder is itself a virtualenv', async () => {
		const folder = await inspectFolder([
			folderFile('pyvenv.cfg', 'home = /usr/bin'),
			folderFile('bin/activate.py'),
			folderFile('lib/python3.13/site-packages/marimo/__init__.py'),
		]);
		expect(folder.files.every((file) => file.exclusion === 'generated')).toBe(true);
	});

	it('enforces the server path and name byte limits', async () => {
		const longName = `${'a'.repeat(MAX_FOLDER_IMPORT_SEGMENT_BYTES - 3)}.py`;
		const segment = 'b'.repeat(MAX_FOLDER_IMPORT_SEGMENT_BYTES - 1);
		const depth = Math.ceil(MAX_FOLDER_IMPORT_PATH_BYTES / (segment.length + 1));
		const longPath = `${Array.from({ length: depth }, () => segment).join('/')}/x.py`;
		const folder = await inspectFolder([
			folderFile(longName),
			folderFile(`${'a'.repeat(MAX_FOLDER_IMPORT_SEGMENT_BYTES)}.py`),
			folderFile(longPath),
		]);
		const errors = Object.fromEntries(folder.files.map((file) => [file.path, file.error]));
		expect(errors[longName]).toBeUndefined();
		expect(errors[`${'a'.repeat(MAX_FOLDER_IMPORT_SEGMENT_BYTES)}.py`]).toMatch(
			String(MAX_FOLDER_IMPORT_SEGMENT_BYTES),
		);
		expect(errors[longPath]).toMatch(String(MAX_FOLDER_IMPORT_PATH_BYTES));
	});

	it('allows explicitly excluding an unreadable supporting file', async () => {
		const file = folderFile('support.py');
		file.slice = () =>
			({
				text: async () => {
					throw new Error('Unreadable');
				},
			}) as unknown as Blob;
		const folder = await inspectFolder([file]);
		expect(folderProblems(folder.files)).toHaveLength(1);
		expect(folderProblems(folder.files.map((entry) => ({ ...entry, included: false })))).toEqual(
			[],
		);
	});
});

describe('prepared manifest', () => {
	it('rejects duplicate entries even when lengths and sizes match', async () => {
		const folder = await inspectFolder([folderFile('a.py'), folderFile('b.py')]);
		const duplicate = { path: 'a.py', size: folder.files[0].file.size };
		expect(() => assertPreparedManifest([duplicate, duplicate], folder.files)).toThrow('differ');
	});
	it('reports file read failures before uploading', async () => {
		const file = folderFile('data.bin');
		file.arrayBuffer = async () => {
			throw new Error('read failed');
		};
		const folder = await inspectFolder([file]);
		await expect(packFolder(folder.files)).rejects.toThrow('Could not read data.bin');
	});
});
