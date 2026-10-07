import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { notebookKeys, projectKeys } from '@/api/queryKeys';
import { notebookImports } from '@/api/notebookImports';
import { ApiRequestError } from '@/api/client';
import { assertPreparedManifest, packFolder } from './folderImport';
import type { FolderFile } from './folderImport';

export interface ImportRow {
	path: string;
	title: string;
	state: 'queued' | 'importing' | 'imported' | 'failed' | 'unknown' | 'expired';
	message?: string;
	notebookId?: string;
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

export function useNotebookImport(projectId: string) {
	const queryClient = useQueryClient();
	const [rows, setRows] = useState<ImportRow[]>([]);
	const [importId, setImportId] = useState<string>();
	const [error, setError] = useState<string>();
	const [phase, setPhase] = useState<'idle' | 'uploading' | 'importing'>('idle');
	const [stopping, setStopping] = useState(false);
	const stopped = useRef(false);
	const active = useRef(false);
	useEffect(
		() => () => {
			stopped.current = true;
		},
		[],
	);

	const updateRow = (path: string, patch: Partial<ImportRow>) =>
		setRows((current) => current.map((row) => (row.path === path ? { ...row, ...patch } : row)));
	const retryable = rows.filter((row) => row.state !== 'imported' && row.state !== 'expired');

	async function run(
		files: FolderFile[],
		settings: { base_image?: string; compute_profile?: string },
	) {
		if (active.current) return;
		active.current = true;
		stopped.current = false;
		setStopping(false);
		setError(undefined);
		const retrying = rows.length > 0;
		const pending = retrying
			? retryable
			: files
					.filter((file) => file.selected)
					.map(
						(file): ImportRow => ({ path: file.path, title: file.title.trim(), state: 'queued' }),
					);
		if (!retrying) setRows(pending);
		try {
			let id = importId;
			if (!id) {
				setPhase('uploading');
				const bytes = await packFolder(files);
				if (stopped.current) {
					setRows([]);
					return;
				}
				const prepared = await notebookImports.prepare(projectId, bytes);
				assertPreparedManifest(
					prepared.files,
					files.filter((file) => file.included),
				);
				id = prepared.id;
				setImportId(id);
			}
			setPhase('importing');
			for (const row of pending) {
				if (stopped.current) break;
				updateRow(row.path, { state: 'importing', message: undefined });
				try {
					if (retrying) {
						const status = await notebookImports.status(projectId, id, row.path);
						if (status.state === 'complete' && status.notebook) {
							updateRow(row.path, { state: 'imported', notebookId: status.notebook.id });
							continue;
						}
						if (status.state === 'preparing') {
							updateRow(row.path, {
								state: 'unknown',
								message: 'Still processing. Check again shortly.',
							});
							continue;
						}
						if (status.state === 'expired') {
							updateRow(row.path, {
								state: 'expired',
								message: 'Upload expired. Start a new import for this notebook.',
							});
							continue;
						}
						if (stopped.current) {
							updateRow(row.path, { state: 'queued' });
							break;
						}
					}
					const notebook = await notebookImports.publish(projectId, id, {
						entry_notebook: row.path,
						title: row.title,
						...settings,
					});
					updateRow(row.path, { state: 'imported', notebookId: notebook.id });
				} catch (error) {
					const unknown =
						!(error instanceof ApiRequestError) ||
						!error.status ||
						error.status >= 500 ||
						error.status === 409;
					updateRow(row.path, {
						state: unknown ? 'unknown' : 'failed',
						message: unknown
							? `Outcome not confirmed. ${importErrorMessage(error)}`
							: importErrorMessage(error),
					});
				}
			}
		} catch (error) {
			// Preparation never publishes notebooks, so its failure can safely return to review.
			setRows([]);
			setError(importErrorMessage(error));
		} finally {
			active.current = false;
			setPhase('idle');
			void queryClient.invalidateQueries({ queryKey: notebookKeys.list(projectId) });
			void queryClient.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
		}
	}

	return {
		rows,
		error,
		setError,
		phase,
		stopping,
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
		},
	};
}
