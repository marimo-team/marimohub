import { mapWithConcurrency } from '@marimo-hub/core/concurrency';
import {
	folderImportFileLimit,
	isNotebookFilePath,
	WORKSPACE_LIMITS,
} from '@marimo-hub/core/remote-workspace';
import {
	folderImportExcludedDirectories,
	isFolderImportExcludedPath,
	validateFolderImportPath,
} from '@marimo-hub/core/workspace-ignore';
import { zip } from 'fflate';
import { formatBytes } from '@/lib/formatBytes';

export interface FolderFile {
	file: File;
	path: string;
	included: boolean;
	exclusion?: 'generated' | 'sensitive';
	error?: string;
	// A conflicting path cannot be excluded on its own, so it is reported even when excluded.
	errorReason?: 'path-conflict' | 'invalid-path' | 'unreadable';
	candidate: boolean;
	selected: boolean;
	title: string;
}

export async function inspectFolder(files: File[]): Promise<{ root: string; files: FolderFile[] }> {
	const root = files[0]?.webkitRelativePath.split('/')[0] ?? '';
	if (!root) throw new Error('Choose a folder so relative paths can be preserved.');
	const relativePaths = files.map((file) => file.webkitRelativePath.slice(root.length + 1));
	const excludedDirectories = folderImportExcludedDirectories(relativePaths);
	const paths = new Set<string>();
	const result = await mapWithConcurrency(files, 8, async (file, index): Promise<FolderFile> => {
		const path = relativePaths[index];
		let errorReason: FolderFile['errorReason'];
		let error: string | undefined;
		if (!file.webkitRelativePath.startsWith(`${root}/`) || paths.has(path)) {
			errorReason = 'path-conflict';
			error = 'Invalid or duplicate folder path';
		} else {
			try {
				validateFolderImportPath(path);
			} catch (cause) {
				errorReason = 'invalid-path';
				error = cause instanceof Error ? cause.message : 'Invalid folder path';
			}
		}
		paths.add(path);
		const name = path.split('/').at(-1) ?? '';
		const generated = isFolderImportExcludedPath(path, excludedDirectories);
		const sensitive =
			/^\.env(?:\.|$)/.test(name) ||
			/\.(pem|key|p12|pfx)$/i.test(name) ||
			/^id_(rsa|ed25519|ecdsa|dsa)(?:$|\.)/.test(name);
		const exclusion = generated ? 'generated' : sensitive ? 'sensitive' : undefined;
		const candidate = isNotebookFilePath(path) && !generated;
		let selected = false;
		if (candidate && !exclusion && !error && file.size <= WORKSPACE_LIMITS.maxFileBytes) {
			try {
				const text = await file.slice(0, 64 * 1024).text();
				selected = /(?:import marimo|from marimo import|marimo-version:)/.test(text);
			} catch {
				errorReason = 'unreadable';
				error = 'File could not be read';
			}
		}
		return {
			file,
			path,
			included: !exclusion,
			exclusion,
			error,
			errorReason,
			candidate,
			selected,
			title: name.replace(/\.[^.]+$/, ''),
		};
	});
	return { root, files: result.sort((a, b) => a.path.localeCompare(b.path)) };
}

export function folderProblems(files: FolderFile[]): string[] {
	const included = files.filter((file) => file.included);
	const problems = files.flatMap((file) =>
		file.error && (file.included || file.errorReason === 'path-conflict')
			? [`${file.path}: ${file.error}`]
			: [],
	);
	const fileLimit = folderImportFileLimit(included);
	if (included.length > fileLimit)
		problems.push(
			`Include at most ${fileLimit} files.${fileLimit < WORKSPACE_LIMITS.maxFiles ? ' One slot is reserved for generated pyproject.toml.' : ''}`,
		);
	if (included.reduce((sum, file) => sum + file.file.size, 0) > WORKSPACE_LIMITS.maxTotalBytes)
		problems.push(`Included files exceed ${formatBytes(WORKSPACE_LIMITS.maxTotalBytes)}.`);
	for (const file of included) {
		if (file.file.size > WORKSPACE_LIMITS.maxFileBytes)
			problems.push(`${file.path} exceeds ${formatBytes(WORKSPACE_LIMITS.maxFileBytes)}.`);
		if (file.selected && !file.title.trim()) problems.push(`${file.path} needs a notebook name.`);
	}
	return problems;
}

export async function packFolder(files: FolderFile[]): Promise<Uint8Array<ArrayBuffer>> {
	const entries: Record<string, Uint8Array> = Object.create(null);
	await mapWithConcurrency(
		files.filter((file) => file.included),
		8,
		async ({ path, file }) => {
			try {
				entries[path] = new Uint8Array(await file.arrayBuffer());
			} catch {
				throw new Error(`Could not read ${path}. Choose the folder again.`);
			}
		},
	);
	return new Promise((resolve, reject) => {
		zip(entries, { level: 0 }, (error, bytes) => {
			if (error) reject(error);
			else resolve(new Uint8Array(bytes));
		});
	});
}

export function assertPreparedManifest(
	files: { path: string; size: number }[],
	included: FolderFile[],
) {
	const expected = new Map(included.map(({ path, file }) => [path, file.size]));
	if (
		files.length !== expected.size ||
		!files.every((file) => expected.get(file.path) === file.size && expected.delete(file.path))
	) {
		throw new Error('Uploaded files differ from your selection. Choose the folder again.');
	}
}
