import { useRef, useState } from 'react';
import { FolderOpen, Upload, Check, LoaderCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { DialogModal, Button, TextField } from '@/components/ui';
import { useCapabilitiesQuery } from '@/api/hooks';
import { folderProblems, inspectFolder } from './folderImport';
import { useNotebookImport, importErrorMessage, importStateLabels } from './useNotebookImport';
import { ImportFileReview } from './ImportFileReview';
import type { FolderFile } from './folderImport';

export default function ImportNotebooksDialog({
	projectId,
	projectName,
	onClose,
}: {
	projectId: string;
	projectName: string;
	onClose: () => void;
}) {
	const queue = useNotebookImport(projectId);
	const { rows, error, setError } = queue;
	const { data: capabilities } = useCapabilitiesQuery();
	const images = capabilities?.sandbox_images ?? [];
	const profiles =
		capabilities?.compute_profile_override === 'editors' ? capabilities.compute_profiles : [];
	const [files, setFiles] = useState<FolderFile[]>([]);
	const [root, setRoot] = useState('');
	const [search, setSearch] = useState('');
	const [baseImage, setBaseImage] = useState('');
	const [computeProfile, setComputeProfile] = useState('');
	const [inspecting, setInspecting] = useState(false);
	const busy = inspecting || queue.busy;
	const input = useRef<HTMLInputElement>(null);
	const problems = folderProblems(files);
	const included = files.filter((file) => file.included);
	const selected = files.filter((file) => file.selected);
	const candidates = files.filter(
		(file) => file.candidate && file.path.toLowerCase().includes(search.toLowerCase()),
	);
	const inProgress = rows.length > 0;
	const completeCount = rows.filter((row) => row.state === 'imported').length;

	const updateFile = (path: string, patch: Partial<FolderFile>) =>
		setFiles((current) =>
			current.map((file) => (file.path === path ? { ...file, ...patch } : file)),
		);

	async function chooseFolder(fileList: FileList | null) {
		if (!fileList?.length) return;
		setInspecting(true);
		setError(undefined);
		try {
			const folder = await inspectFolder([...fileList]);
			setRoot(folder.root);
			setSearch('');
			setFiles(folder.files);
		} catch (error) {
			setError(importErrorMessage(error));
		}
		setInspecting(false);
	}

	function run() {
		void queue.run(files, {
			...(baseImage ? { base_image: baseImage } : {}),
			...(computeProfile ? { compute_profile: computeProfile } : {}),
		});
	}

	return (
		<DialogModal
			isOpen
			onClose={() => {
				if (!busy) onClose();
			}}
			title="Import notebooks"
			width="xl"
			contentClassName="flex min-h-0 flex-col overflow-hidden p-0"
		>
			<div className="flex min-h-0 flex-col">
				<div className="space-y-5 overflow-y-auto p-5">
					<p className="text-sm text-muted-foreground">
						{inProgress ? 'Import' : root ? 'Review notebooks and files' : 'Choose source'}{' '}
						<span aria-hidden="true">·</span> {projectName}
					</p>
					{error && (
						<p
							role="alert"
							className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
						>
							{error}
						</p>
					)}
					{!inProgress && (
						<>
							<div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 p-4">
								<div className="min-w-0">
									<div className="flex items-center gap-2 font-medium">
										<FolderOpen className="size-4" />
										{root || 'Import a folder'}
									</div>
									<p className="mt-1 text-sm text-muted-foreground">
										{root
											? `${files.length} files found`
											: 'Choose the common parent of your notebooks, Python modules, and data files.'}
									</p>
								</div>
								<input
									ref={(element) => {
										input.current = element;
										element?.setAttribute('webkitdirectory', '');
									}}
									type="file"
									multiple
									hidden
									aria-label="Choose folder"
									onChange={(event) => {
										void chooseFolder(event.target.files);
										event.target.value = '';
									}}
								/>
								<Button isDisabled={busy} onPress={() => input.current?.click()}>
									{inspecting ? 'Reading folder…' : root ? 'Change folder' : 'Choose folder'}
								</Button>
							</div>
							{root && (
								<>
									<p className="text-sm text-muted-foreground">
										Each notebook gets its own copy of the included files. Edits are not shared.
										Paths stay relative to this folder.
									</p>
									<TextField
										aria-label="Search notebook paths"
										placeholder="Search notebook paths…"
										value={search}
										onChange={setSearch}
									/>
									<div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
										<span>
											{selected.length} selected · {candidates.length} matching notebooks
										</span>
										<div className="flex gap-2">
											<Button
												size="sm"
												variant="ghost"
												isDisabled={!candidates.some((file) => !file.selected && !file.error)}
												onPress={() => {
													const paths = new Set(
														candidates.filter((file) => !file.error).map((file) => file.path),
													);
													setFiles((current) =>
														current.map((file) =>
															paths.has(file.path)
																? { ...file, selected: true, included: true }
																: file,
														),
													);
												}}
											>
												Select matching
											</Button>
											<Button
												size="sm"
												variant="ghost"
												isDisabled={selected.length === 0}
												onPress={() =>
													setFiles((current) =>
														current.map((file) => ({ ...file, selected: false })),
													)
												}
											>
												Clear selection
											</Button>
										</div>
									</div>
									<div className="max-h-72 overflow-auto rounded-lg border">
										<table className="w-full table-fixed text-left text-sm">
											<thead className="sticky top-0 bg-muted">
												<tr>
													<th className="w-12 p-3">
														<span className="sr-only">Import</span>
													</th>
													<th className="p-3">Notebook path</th>
													<th className="p-3">Name in {projectName}</th>
												</tr>
											</thead>
											<tbody>
												{candidates.map((file) => (
													<tr key={file.path} className="border-t">
														<td className="p-3">
															<input
																type="checkbox"
																className="size-4 accent-primary"
																aria-label={`Import ${file.path}`}
																checked={file.selected}
																disabled={!!file.error}
																onChange={(event) =>
																	updateFile(file.path, {
																		selected: event.target.checked,
																		...(event.target.checked ? { included: true } : {}),
																	})
																}
															/>
														</td>
														<td className="break-all p-3 font-mono text-xs">{file.path}</td>
														<td className="p-3">
															<TextField
																aria-label={`Name for ${file.path}`}
																value={file.title}
																maxLength={200}
																isDisabled={!file.selected}
																onChange={(title) => updateFile(file.path, { title })}
															/>
														</td>
													</tr>
												))}
												{candidates.length === 0 && (
													<tr>
														<td colSpan={3} className="p-6 text-center text-muted-foreground">
															{search
																? 'No notebook paths match your search.'
																: 'No supported notebooks found. Choose a folder containing .py, .md, .markdown, or .qmd files.'}
														</td>
													</tr>
												)}
											</tbody>
										</table>
									</div>
									<p className="text-xs text-muted-foreground">
										Likely marimo notebooks are selected. Unchecking a notebook keeps its file
										available as a supporting file.
									</p>
									<ImportFileReview files={files} onChange={updateFile} />
									{(images.length > 0 || profiles.length > 0) && (
										<details className="rounded-lg border p-3">
											<summary className="cursor-pointer text-sm font-medium">
												Import settings
											</summary>
											<div className="mt-3 grid gap-4 sm:grid-cols-2">
												{images.length > 0 && (
													<label className="space-y-1 text-sm">
														<span>Base image</span>
														<select
															className="block w-full rounded-md border bg-background p-2"
															value={baseImage}
															onChange={(event) => setBaseImage(event.target.value)}
														>
															<option value="">Deployment default</option>
															{images.map((image) => (
																<option key={image} value={image}>
																	{image}
																</option>
															))}
														</select>
													</label>
												)}
												{profiles.length > 0 && (
													<label className="space-y-1 text-sm">
														<span>Compute profile</span>
														<select
															className="block w-full rounded-md border bg-background p-2"
															value={computeProfile}
															onChange={(event) => setComputeProfile(event.target.value)}
														>
															<option value="">Deployment default</option>
															{profiles.map((profile) => (
																<option key={profile.name} value={profile.name}>
																	{profile.name}
																</option>
															))}
														</select>
													</label>
												)}
											</div>
										</details>
									)}
									{problems.length > 0 && (
										<ul role="alert" className="list-inside list-disc text-sm text-destructive">
											{problems.map((problem) => (
												<li key={problem}>{problem}</li>
											))}
										</ul>
									)}
								</>
							)}
						</>
					)}
					{inProgress && (
						<>
							<p className="text-sm" aria-live="polite">
								{completeCount} of {rows.length} imported
								{queue.phase === 'uploading' ? ' · Preparing and uploading folder…' : ''}
								{queue.stopping && busy ? ' · Stopping after the current request…' : ''}
							</p>
							<div className="divide-y rounded-lg border">
								{rows.map((row) => (
									<div key={row.path} className="flex items-start gap-3 p-3">
										{row.state === 'imported' ? (
											<Check className="mt-1 size-4 text-emerald-600" />
										) : row.state === 'importing' ? (
											<LoaderCircle className="mt-1 size-4 animate-spin" />
										) : (
											<span className="mt-1 size-4" />
										)}
										<div className="min-w-0 flex-1">
											<p className="text-sm font-medium">{row.title}</p>
											<p className="break-all font-mono text-xs text-muted-foreground">
												{row.path}
											</p>
											{row.message && (
												<p className="mt-1 text-xs text-destructive">{row.message}</p>
											)}
										</div>
										<div className="shrink-0 text-xs">
											{row.notebookId ? (
												<Link
													className="text-primary underline"
													to={`/projects/${projectId}/notebooks/${row.notebookId}`}
												>
													View notebook
												</Link>
											) : (
												importStateLabels[row.state]
											)}
										</div>
									</div>
								))}
							</div>
							<p className="text-xs text-muted-foreground">
								{completeCount === rows.length
									? 'Your notebooks are ready. Each has its own copy of the included files.'
									: 'Keep this page open until the import finishes. Stop lets the current request finish and keeps imported notebooks. You can retry this upload for 24 hours.'}
							</p>
						</>
					)}
				</div>
				<div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-5 py-4">
					<p className="text-sm text-muted-foreground">
						{!inProgress && root
							? `Creates ${selected.length} ${selected.length === 1 ? 'notebook' : 'notebooks'}, each with a copy of these ${included.length} files.`
							: ''}
					</p>
					<div className="flex gap-2">
						<Button isDisabled={busy} onPress={onClose}>
							{inProgress ? (completeCount === rows.length ? 'View notebooks' : 'Close') : 'Cancel'}
						</Button>
						{busy && inProgress ? (
							<Button onPress={queue.stop} isDisabled={queue.stopping}>
								{queue.stopping ? 'Stopping…' : 'Stop import'}
							</Button>
						) : inProgress ? (
							queue.canRetry && (
								<Button variant="primary" onPress={run}>
									{queue.retryLabel}
								</Button>
							)
						) : (
							<Button
								variant="primary"
								isDisabled={busy || selected.length === 0 || problems.length > 0}
								onPress={run}
							>
								<Upload className="size-4" />
								Import {selected.length > 0 ? selected.length : ''}{' '}
								{selected.length === 1 ? 'notebook' : 'notebooks'}
							</Button>
						)}
					</div>
				</div>
			</div>
		</DialogModal>
	);
}
