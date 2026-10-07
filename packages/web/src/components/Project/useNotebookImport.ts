import { useEffect, useRef, useState } from 'react';
import { notebookKeys, projectKeys } from '@/api/queryKeys';
import { notebookImports } from '@/api/notebookImports';
import { useInvalidate } from '@/api/mutation';
import { ApiRequestError } from '@/api/client';
import { assertPreparedManifest, packFolder } from './folderImport';
import type { FolderFile } from './folderImport';

export interface ImportRow {
	path: string;
	title: string;
	state: 'queued' | 'importing' | 'imported' | 'failed' | 'unknown' | 'expired';
	message?: string;
	messageTone?: 'neutral';
	notebookId?: string;
	retryable?: boolean;
}

export const importStateLabels: Record<ImportRow['state'], string> = {
	queued: 'Queued',
	importing: 'Importing…',
	imported: 'Imported',
	failed: 'Failed',
	unknown: 'Outcome unknown',
	expired: 'Expired',
};
export const importErrorMessage = (error: unknown) =>
	error instanceof Error ? error.message : 'Import failed. Please try again.';

export const isImportRetryable = (row: ImportRow) =>
	row.state !== 'imported' && row.state !== 'expired' && row.retryable !== false;

type ImportSettings = { base_image?: string; compute_profile?: string };
type ImportOutcome = Awaited<ReturnType<typeof notebookImports.get>>['notebooks'][number];

function publishFailure(error: unknown): Partial<ImportRow> {
	const restartRequired =
		error instanceof ApiRequestError && error.code === 'IMPORT_RESTART_REQUIRED';
	const unknown =
		!restartRequired &&
		(!(error instanceof ApiRequestError) ||
			!error.status ||
			error.status >= 500 ||
			error.status === 409);
	return {
		state: unknown ? 'unknown' : 'failed',
		retryable: !restartRequired,
		message: unknown
			? `Outcome not confirmed. ${importErrorMessage(error)}`
			: restartRequired
				? `${importErrorMessage(error)}. Check the project before starting another import.`
				: importErrorMessage(error),
	};
}

function reconciled(outcome: ImportOutcome | undefined): Partial<ImportRow> | undefined {
	if (outcome?.state === 'complete' && outcome.notebook)
		return { state: 'imported', notebookId: outcome.notebook.id };
	if (outcome?.state === 'preparing')
		return {
			state: 'unknown',
			message: 'Still processing. Check again shortly.',
			messageTone: 'neutral',
		};
	// The server fences `expired` for several causes (upload expiry, retry limit, deleted
	// notebook) without saying which, so the message must not name one.
	if (outcome?.state === 'expired')
		return {
			state: 'expired',
			message: 'This import can no longer continue. Start a new import for this notebook.',
		};
	// Absent and `publishing` entries are safe to publish: the server resumes them idempotently.
	return undefined;
}

export function useNotebookImport(projectId: string) {
	const invalidate = useInvalidate();
	const [rows, setRows] = useState<ImportRow[]>([]);
	const [importId, setImportId] = useState<string>();
	const [expiresAt, setExpiresAt] = useState<string>();
	const [error, setError] = useState<string>();
	const [phase, setPhase] = useState<'idle' | 'uploading' | 'importing'>('idle');
	const [stopping, setStopping] = useState(false);
	const stopped = useRef(false);
	const active = useRef(false);
	const upload = useRef<AbortController | undefined>(undefined);
	useEffect(
		() => () => {
			stopped.current = true;
			upload.current?.abort();
		},
		[],
	);

	const updateRow = (path: string, patch: Partial<ImportRow>) =>
		setRows((current) => current.map((row) => (row.path === path ? { ...row, ...patch } : row)));
	const retryable = rows.filter(isImportRetryable);

	async function prepare(files: FolderFile[]): Promise<string | undefined> {
		setPhase('uploading');
		const bytes = await packFolder(files);
		if (stopped.current) return;
		const controller = new AbortController();
		upload.current = controller;
		const prepared = await notebookImports.prepare(projectId, bytes, controller.signal);
		upload.current = undefined;
		assertPreparedManifest(
			prepared.files,
			files.filter((file) => file.included),
		);
		setImportId(prepared.id);
		setExpiresAt(prepared.expires_at);
		return prepared.id;
	}

	async function lookUpOutcomes(id: string, pending: ImportRow[]) {
		for (const row of pending) updateRow(row.path, { state: 'queued', message: undefined });
		try {
			const outcome = await notebookImports.get(projectId, id);
			return new Map(outcome.notebooks.map((notebook) => [notebook.entry_notebook, notebook]));
		} catch (error) {
			// A purged import answers 404; retrying its id can never succeed.
			const gone = error instanceof ApiRequestError && error.status === 404;
			for (const row of pending)
				updateRow(
					row.path,
					gone
						? {
								state: 'expired',
								message: 'This import has expired. Start a new import for this notebook.',
								messageTone: undefined,
							}
						: {
								state: 'unknown',
								message: `Outcome not confirmed. ${importErrorMessage(error)}`,
								messageTone: undefined,
							},
				);
			return null;
		}
	}

	async function publishAll(
		id: string,
		pending: ImportRow[],
		retrying: boolean,
		settings: ImportSettings,
	) {
		setPhase('importing');
		const outcomes = retrying
			? await lookUpOutcomes(id, pending)
			: new Map<string, ImportOutcome>();
		if (!outcomes) return;
		for (const row of pending) {
			const known = reconciled(outcomes.get(row.path));
			if (known) {
				updateRow(row.path, { message: undefined, messageTone: undefined, ...known });
				continue;
			}
			if (stopped.current) break;
			updateRow(row.path, { state: 'importing', message: undefined, messageTone: undefined });
			try {
				const notebook = await notebookImports.publish(projectId, id, {
					entry_notebook: row.path,
					title: row.title,
					...settings,
				});
				updateRow(row.path, { state: 'imported', notebookId: notebook.id });
			} catch (error) {
				updateRow(row.path, publishFailure(error));
			}
		}
	}

	async function run(files: FolderFile[], settings: ImportSettings) {
		if (active.current) return;
		active.current = true;
		stopped.current = false;
		setStopping(false);
		setError(undefined);
		const retrying = rows.length > 0;
		const pending = retrying
			? retryable
			: files.flatMap((file): ImportRow[] =>
					file.selected ? [{ path: file.path, title: file.title.trim(), state: 'queued' }] : [],
				);
		if (!retrying) setRows(pending);
		try {
			const id = importId ?? (await prepare(files));
			if (id) await publishAll(id, pending, retrying, settings);
			else setRows([]);
		} catch (error) {
			// Preparation never publishes notebooks, so its failure can safely return to review.
			upload.current = undefined;
			setRows([]);
			if (!stopped.current) setError(importErrorMessage(error));
		}
		active.current = false;
		setPhase('idle');
		invalidate(notebookKeys.list(projectId), projectKeys.detail(projectId));
	}

	return {
		rows,
		error,
		setError,
		phase,
		stopping,
		expiresAt,
		run,
		busy: phase !== 'idle',
		canRetry: retryable.length > 0,
		retryLabel: rows.some((row) => row.state === 'unknown')
			? 'Check outcomes and retry'
			: rows.some((row) => row.state === 'failed')
				? 'Retry remaining'
				: 'Resume import',
		stop() {
			stopped.current = true;
			setStopping(true);
			upload.current?.abort();
		},
	};
}
