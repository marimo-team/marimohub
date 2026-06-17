import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Folder, X } from 'lucide-react';
import { Button, TextField, DialogModal } from '@/components/ui';
import { useProjectsQuery, useCreateProject, useDeleteProject } from '@/api/hooks';
import type { ProjectSummary } from '@/types';

export function ProjectList() {
	const [searchQuery, setSearchQuery] = useState('');
	const [showCreateModal, setShowCreateModal] = useState(false);
	const [newProjectName, setNewProjectName] = useState('');
	const [newProjectDescription, setNewProjectDescription] = useState('');
	const [deleteModal, setDeleteModal] = useState<ProjectSummary | null>(null);
	const navigate = useNavigate();

	const { data: projects } = useProjectsQuery();
	const createProject = useCreateProject();
	const deleteProject = useDeleteProject();

	const handleCreate = () => {
		const name = newProjectName.trim();
		if (!name) return;

		createProject.mutate(
			{ name, description: newProjectDescription.trim() || name },
			{
				onSuccess: () => {
					toast.success(`Created project "${name}"`);
					setNewProjectName('');
					setNewProjectDescription('');
					setShowCreateModal(false);
				},
				onError: (err) => {
					toast.error(err.message);
				},
			},
		);
	};

	const handleDelete = () => {
		if (!deleteModal) return;

		deleteProject.mutate(deleteModal.id, {
			onSuccess: () => {
				toast.success(`Deleted "${deleteModal.name}"`);
				setDeleteModal(null);
			},
			onError: (err) => {
				toast.error(err.message);
			},
		});
	};

	const filteredProjects = projects.filter(
		(p) =>
			p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
			p.description.toLowerCase().includes(searchQuery.toLowerCase()),
	);

	return (
		<div className="flex flex-1 justify-center overflow-y-auto bg-muted/30 p-6 max-md:p-3">
			<div className="w-full max-w-2xl">
				<div className="mb-6 flex items-center justify-between max-md:flex-col max-md:items-start max-md:gap-3">
					<h1 className="text-xl font-semibold tracking-tight">Projects</h1>
					<Button variant="primary" onPress={() => setShowCreateModal(true)}>
						+ New Project
					</Button>
				</div>

				<div className="mb-4">
					<TextField
						placeholder="Search projects..."
						value={searchQuery}
						onChange={setSearchQuery}
					/>
				</div>

				{filteredProjects.length === 0 ? (
					<div className="flex flex-col items-center gap-4 rounded-lg border border-dashed bg-card p-12 text-center text-muted-foreground">
						{searchQuery ? (
							<p>No projects matching "{searchQuery}"</p>
						) : (
							<>
								<p>No projects yet</p>
								<Button variant="ghost" onPress={() => setShowCreateModal(true)}>
									Create your first project
								</Button>
							</>
						)}
					</div>
				) : (
					<div className="flex flex-col overflow-hidden rounded-lg border bg-card shadow-sm">
						{filteredProjects.map((project) => (
							<div
								key={project.id}
								className="group flex cursor-pointer flex-col gap-1 border-b border-l-[3px] border-l-transparent px-4 py-3 transition-colors last:border-b-0 hover:border-l-primary hover:bg-muted/60"
								onClick={() => navigate(`/projects/${project.id}`)}
							>
								<div className="flex items-center gap-2">
									<Folder className="size-4 text-muted-foreground transition-colors group-hover:text-primary" />
									<span className="text-sm font-medium">{project.name}</span>
									<span className="ml-auto text-xs text-muted-foreground">
										{project.notebook_count} notebook
										{project.notebook_count !== 1 ? 's' : ''}
									</span>
								</div>
								<div className="flex items-center justify-between pl-6">
									<span className="truncate text-xs text-muted-foreground">
										{project.description}
									</span>
									<button
										className="flex size-7 items-center justify-center text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
										onClick={(e) => {
											e.stopPropagation();
											setDeleteModal(project);
										}}
										title="Delete project"
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
				isOpen={showCreateModal}
				onClose={() => setShowCreateModal(false)}
				title="Create New Project"
				width="sm"
			>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						handleCreate();
					}}
				>
					<div className="flex flex-col gap-4">
						<TextField
							label="Project Name"
							placeholder="My Analysis"
							value={newProjectName}
							onChange={setNewProjectName}
							autoFocus
						/>
						<TextField
							label="Description"
							placeholder="Optional description"
							value={newProjectDescription}
							onChange={setNewProjectDescription}
						/>
						<div className="flex justify-end gap-2 pt-2 max-md:flex-col">
							<Button variant="ghost" onPress={() => setShowCreateModal(false)}>
								Cancel
							</Button>
							<Button type="submit" variant="primary" isDisabled={createProject.isPending}>
								{createProject.isPending ? 'Creating...' : 'Create'}
							</Button>
						</div>
					</div>
				</form>
			</DialogModal>

			<DialogModal
				isOpen={!!deleteModal}
				onClose={() => setDeleteModal(null)}
				title="Delete Project"
				width="sm"
			>
				<div className="flex flex-col gap-4">
					<p className="text-sm leading-relaxed text-muted-foreground">
						Are you sure you want to delete "{deleteModal?.name}"? All notebooks in this project
						will be deleted. This action cannot be undone.
					</p>
					<div className="flex justify-end gap-2 pt-2 max-md:flex-col">
						<Button variant="ghost" onPress={() => setDeleteModal(null)}>
							Cancel
						</Button>
						<Button variant="danger" onPress={handleDelete} isDisabled={deleteProject.isPending}>
							{deleteProject.isPending ? 'Deleting...' : 'Delete'}
						</Button>
					</div>
				</div>
			</DialogModal>
		</div>
	);
}
