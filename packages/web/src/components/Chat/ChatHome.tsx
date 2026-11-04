import type { ReactNode } from 'react';
import { BookOpen, Clock, Database, History, Notebook, PlayCircle, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Brand, Button, LinkButton } from '@/components/ui';
import type { Capabilities, NotebookEntry, ProjectDetail } from '@/types';
import type { ConversationSummary } from '@/api/conversations';
import { canEditProject } from '@/lib/roles';
import { ConversationList } from './ConversationList';

export function ChatHome({
	projectPath,
	project,
	capabilities,
	composer,
	conversations,
	notebooks,
	busy,
	onPickPrompt,
	onSelect,
	onDelete,
	onOpenHistory,
}: {
	projectPath: string;
	project: ProjectDetail;
	capabilities?: Capabilities;
	composer: ReactNode;
	conversations: ConversationSummary[];
	notebooks: NotebookEntry[];
	busy: boolean;
	onPickPrompt: (prompt: string) => void;
	onSelect: (id: string) => void;
	onDelete: (item: ConversationSummary) => void;
	onOpenHistory: () => void;
}) {
	const canEdit = canEditProject(project.your_role);
	const prompts = [
		{
			icon: Sparkles,
			title: 'Explore this project',
			description: 'Get an overview of the notebooks and what they do.',
			prompt: 'Give me an overview of this project and what I can work on.',
		},
		{
			icon: BookOpen,
			title: 'Explain a notebook',
			description: 'Read its source and walk through the analysis.',
			prompt: 'Read a notebook in this project and explain its data transformations and outputs.',
		},
		...(canEdit
			? [
					{
						icon: PlayCircle,
						title: 'Create a notebook',
						description: 'Draft a new marimo notebook and open it beside the chat.',
						prompt:
							'Create a new notebook in this project that loads a sample dataset and plots it.',
					},
				]
			: []),
		...(capabilities?.jobs?.available && canEdit
			? [
					{
						icon: Clock,
						title: 'Schedule a notebook',
						description: 'Set up a recurring job for an existing notebook.',
						prompt: 'Help me create a scheduled job for a notebook in this project.',
					},
				]
			: []),
	];
	return (
		<div className="mx-auto w-full max-w-5xl">
			<div className="flex flex-col items-center pb-8 pt-9 text-center sm:pb-10 sm:pt-14">
				<Brand size="lg" className="mb-6" />
				<h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
					What would you like to do?
				</h1>
				<p className="mt-3 text-sm text-muted-foreground">
					Ask about notebooks, run code, or manage work in {project.name}.
				</p>
			</div>
			{composer}
			<div className="mx-auto mt-5 flex max-w-4xl flex-wrap justify-center gap-2">
				<LinkButton to={projectPath}>
					<Notebook className="size-4" aria-hidden />
					Notebooks
				</LinkButton>
				{capabilities?.data_browser?.available && canEdit ? (
					<LinkButton to={`${projectPath}/data`}>
						<Database className="size-4" aria-hidden />
						Data
					</LinkButton>
				) : null}
				{capabilities?.jobs?.available ? (
					<LinkButton to={`${projectPath}/jobs`}>
						<Clock className="size-4" aria-hidden />
						Jobs
					</LinkButton>
				) : null}
			</div>
			<div className="mt-12 grid grid-cols-1 gap-10 pb-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-16">
				<div>
					<h2 className="mb-5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
						<Sparkles className="size-3.5" aria-hidden />
						Ask marimohub
					</h2>
					<div className="space-y-1">
						{prompts.map(({ icon: Icon, title, description, prompt }) => (
							<Button
								key={title}
								variant="unstyled"
								onPress={() => onPickPrompt(prompt)}
								className="flex w-full items-start gap-3 rounded-lg px-2 py-3 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
							>
								<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
									<Icon className="size-4" aria-hidden />
								</span>
								<span className="min-w-0">
									<span className="block text-sm font-medium">{title}</span>
									<span className="mt-0.5 block text-sm text-muted-foreground">{description}</span>
								</span>
							</Button>
						))}
					</div>
				</div>
				<div className="space-y-8">
					<div>
						<div className="mb-4 flex items-center justify-between">
							<h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
								<History className="size-3.5" aria-hidden />
								Recent conversations
							</h2>
							{conversations.length > 4 ? (
								<Button size="sm" variant="ghost" onPress={onOpenHistory}>
									View all
								</Button>
							) : null}
						</div>
						{conversations.length > 0 ? (
							<ConversationList
								items={conversations.slice(0, 4)}
								selected={null}
								busy={busy}
								onSelect={onSelect}
								onDelete={onDelete}
							/>
						) : (
							<p className="px-2 py-3 text-sm leading-6 text-muted-foreground">
								Start a conversation above. Your history is private and saved in this project.
							</p>
						)}
					</div>
					<div>
						<h2 className="mb-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
							<Notebook className="size-3.5" aria-hidden />
							Notebooks
						</h2>
						<ul className="space-y-1">
							{notebooks.slice(0, 5).map((notebook) => (
								<li key={notebook.id}>
									<Link
										to={`${projectPath}/notebooks/${encodeURIComponent(notebook.id)}`}
										className="flex items-center gap-3 rounded-lg px-2 py-2.5 text-sm outline-none transition-colors hover:bg-accent/60 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
									>
										<Notebook className="size-4 shrink-0 text-muted-foreground" aria-hidden />
										<span className="truncate">{notebook.title}</span>
									</Link>
								</li>
							))}
						</ul>
						{notebooks.length === 0 ? (
							<Link
								to={projectPath}
								className="px-2 text-sm font-medium text-primary underline-offset-4 hover:underline"
							>
								Create your first notebook
							</Link>
						) : null}
					</div>
				</div>
			</div>
		</div>
	);
}
