import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, FileText, X } from 'lucide-react';
import { Button, TextField, DialogModal } from '@/components/ui';
import { useNotebooksQuery, useCreateNotebook, useDeleteNotebook } from '@/api/hooks';
import type { NotebookEntry } from '@/types';

export function Home() {
	const { pid } = useParams<{ pid: string }>();
	const navigate = useNavigate();
	const [searchQuery, setSearchQuery] = useState('');
	const [showUploadModal, setShowUploadModal] = useState(false);
	const [newNotebookName, setNewNotebookName] = useState('');
	const [deleteModal, setDeleteModal] = useState<NotebookEntry | null>(null);

	const { data: notebooks } = useNotebooksQuery(pid!);
	const createNotebook = useCreateNotebook(pid!);
	const deleteNotebook = useDeleteNotebook(pid!);

	const handleUpload = () => {
		const name = newNotebookName.trim();
		if (!name) return;

		createNotebook.mutate(
			{
				title: name,
				description: name,
				code: `import marimo\n\napp = marimo.App()\n\n@app.cell\ndef _():\n    import marimo as mo\n    mo.md("# ${name}")\n    return\n\nif __name__ == "__main__":\n    app.run()\n`,
			},
			{
				onSuccess: () => {
					toast.success(`Created "${name}"`);
					setNewNotebookName('');
					setShowUploadModal(false);
				},
				onError: (err) => {
					toast.error(err.message);
				},
			},
		);
	};

	const handleDelete = () => {
		if (!deleteModal) return;

		deleteNotebook.mutate(deleteModal.id, {
			onSuccess: () => {
				toast.success(`Deleted "${deleteModal.title}"`);
				setDeleteModal(null);
			},
			onError: (err) => {
				toast.error(err.message);
			},
		});
	};

	const filteredNotebooks = notebooks.filter((nb) =>
		nb.title.toLowerCase().includes(searchQuery.toLowerCase()),
	);

	return (
		<div className="flex flex-1 justify-center overflow-y-auto bg-muted/30 p-6 max-md:p-3">
			<div className="w-full max-w-2xl">
				<div className="mb-6 flex items-center justify-between max-md:flex-col max-md:items-start max-md:gap-3">
					<div className="flex items-center gap-2">
						<button
							className="flex size-8 items-center justify-center rounded-md border border-input text-muted-foreground shadow-xs transition-colors hover:border-ring hover:bg-muted hover:text-foreground"
							onClick={() => navigate('/')}
							title="Back to projects"
						>
							<ArrowLeft className="size-4" />
						</button>
						<h1 className="text-xl font-semibold tracking-tight">Notebooks</h1>
					</div>
					<Button variant="primary" onPress={() => setShowUploadModal(true)}>
						+ New Notebook
					</Button>
				</div>

				<div className="mb-4">
					<TextField
						placeholder="Search notebooks..."
						value={searchQuery}
						onChange={setSearchQuery}
					/>
				</div>

				{filteredNotebooks.length === 0 ? (
					<div className="flex flex-col items-center gap-4 rounded-lg border border-dashed bg-card p-12 text-center text-muted-foreground">
						{searchQuery ? (
							<p>No notebooks matching "{searchQuery}"</p>
						) : (
							<>
								<p>No notebooks yet</p>
								<Button variant="ghost" onPress={() => setShowUploadModal(true)}>
									Create your first notebook
								</Button>
							</>
						)}
					</div>
				) : (
					<div className="flex flex-col overflow-hidden rounded-lg border bg-card shadow-sm">
						{filteredNotebooks.map((nb) => (
							<div
								key={nb.id}
								className="group flex cursor-pointer items-center justify-between border-b border-l-[3px] border-l-transparent px-4 py-3 transition-colors last:border-b-0 hover:border-l-primary hover:bg-muted/60"
								onClick={() =>
									navigate(`/projects/${pid}/notebooks/${nb.id}`, { state: { title: nb.title } })
								}
							>
								<div className="flex items-center gap-2">
									<FileText className="size-4 text-muted-foreground transition-colors group-hover:text-primary" />
									<span className="text-sm font-medium">{nb.title}</span>
								</div>
								<div className="flex items-center gap-3">
									<span className="text-xs text-muted-foreground">
										{nb.tags.length > 0 ? nb.tags.join(', ') : nb.status}
									</span>
									<span className="text-xs text-muted-foreground">
										{new Date(nb.updated_at).toLocaleDateString()}
									</span>
									<button
										className="flex size-7 items-center justify-center text-muted-foreground opacity-0 transition-colors hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 max-md:opacity-100"
										onClick={(e) => {
											e.stopPropagation();
											setDeleteModal(nb);
										}}
										title="Delete notebook"
									>
										<X className="size-4" />
									</button>
								</div>
							</div>
						))}
					</div>
				)}
			</div>

			<DialogModal
				isOpen={showUploadModal}
				onClose={() => setShowUploadModal(false)}
				title="Create New Notebook"
				width="sm"
			>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						handleUpload();
					}}
				>
					<div className="flex flex-col gap-4">
						<TextField
							label="Notebook Name"
							placeholder="my_analysis"
							value={newNotebookName}
							onChange={setNewNotebookName}
							autoFocus
						/>
						<div className="flex justify-end gap-2 pt-2 max-md:flex-col">
							<Button variant="ghost" onPress={() => setShowUploadModal(false)}>
								Cancel
							</Button>
							<Button type="submit" variant="primary" isDisabled={createNotebook.isPending}>
								{createNotebook.isPending ? 'Creating...' : 'Create'}
							</Button>
						</div>
					</div>
				</form>
			</DialogModal>

			<DialogModal
				isOpen={!!deleteModal}
				onClose={() => setDeleteModal(null)}
				title="Delete Notebook"
				width="sm"
			>
				<div className="flex flex-col gap-4">
					<p className="text-sm leading-relaxed text-muted-foreground">
						Are you sure you want to delete "{deleteModal?.title}"? This action cannot be undone.
					</p>
					<div className="flex justify-end gap-2 pt-2 max-md:flex-col">
						<Button variant="ghost" onPress={() => setDeleteModal(null)}>
							Cancel
						</Button>
						<Button variant="danger" onPress={handleDelete} isDisabled={deleteNotebook.isPending}>
							{deleteNotebook.isPending ? 'Deleting...' : 'Delete'}
						</Button>
					</div>
				</div>
			</DialogModal>
		</div>
	);
}
