import { useState } from 'react';
import {
	Button,
	Label,
	ListBox,
	ListBoxItem,
	Popover,
	Select,
	SelectValue,
} from 'react-aria-components';
import { Check, ChevronsUpDown, Folder, Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { CreateProjectDialog } from '@/components/ProjectList/CreateProjectDialog';
import { useDisclosure } from '@/hooks/useDisclosure';

export function ProjectPicker({
	projects,
	selectedId,
	selectedName,
	isPending,
	canCreate,
	onNavigate,
}: {
	projects: { id: string; name: string }[];
	selectedId?: string;
	selectedName?: string;
	isPending: boolean;
	canCreate: boolean;
	onNavigate?: () => void;
}) {
	const navigate = useNavigate();
	const [isOpen, setOpen] = useState(false);
	const createDialog = useDisclosure();
	const options =
		selectedId && !projects.some((project) => project.id === selectedId)
			? [...projects, { id: selectedId, name: selectedName ?? 'Current project' }]
			: projects;
	const openProject = (id: string) => {
		void navigate(`/projects/${encodeURIComponent(id)}`);
		onNavigate?.();
	};
	const createButton = (
		<Button
			onPress={() => {
				setOpen(false);
				createDialog.open();
			}}
			className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
		>
			<Plus className="size-4" aria-hidden />
			New project
		</Button>
	);
	return (
		<>
			<Select
				isDisabled={options.length === 0}
				value={selectedId ?? null}
				onChange={(id) => {
					if (typeof id === 'string') openProject(id);
				}}
				isOpen={isOpen}
				onOpenChange={setOpen}
				placeholder={isPending ? 'Loading projects…' : 'All projects'}
				className="space-y-2"
			>
				<Label className="block px-2 text-xs font-medium text-muted-foreground">Project</Label>
				<Button className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-sidebar-border bg-background px-3 py-2 text-left text-sm font-semibold outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring">
					<Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
					<SelectValue className="min-w-0 flex-1 truncate" />
					<ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
				</Button>
				<Popover
					placement="bottom start"
					offset={6}
					className="z-50 w-(--trigger-width) min-w-56 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg"
				>
					<ListBox
						items={options}
						className="max-h-64 overflow-y-auto overscroll-contain p-1 outline-none"
						renderEmptyState={() => (
							<p className="px-3 py-2 text-sm text-muted-foreground">
								{isPending ? 'Loading projects…' : 'No projects yet'}
							</p>
						)}
					>
						{(project) => (
							<ListBoxItem
								id={project.id}
								textValue={project.name}
								className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm outline-none data-[focused]:bg-accent data-[focused]:text-accent-foreground max-md:min-h-11"
							>
								{({ isSelected }) => (
									<>
										<span className="min-w-0 flex-1 truncate">{project.name}</span>
										{isSelected ? (
											<Check className="size-4 shrink-0 text-primary" aria-hidden />
										) : null}
									</>
								)}
							</ListBoxItem>
						)}
					</ListBox>
					{canCreate ? <div className="border-t p-1">{createButton}</div> : null}
				</Popover>
			</Select>
			{canCreate && options.length === 0 ? createButton : null}
			{canCreate ? (
				<CreateProjectDialog
					isOpen={createDialog.isOpen}
					onClose={createDialog.close}
					onCreated={openProject}
				/>
			) : null}
		</>
	);
}
