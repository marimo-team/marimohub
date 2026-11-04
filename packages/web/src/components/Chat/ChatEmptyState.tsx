import type { ReactNode } from 'react';
import { BookOpen, Clock, NotebookPen, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui';
import { useUserQuery } from '@/api/hooks';
import type { Capabilities, ProjectDetail } from '@/types';
import { canEditProject } from '@/lib/roles';

export function ChatEmptyState({
	project,
	capabilities,
	composer,
	onPickPrompt,
}: {
	project: ProjectDetail;
	capabilities?: Capabilities;
	composer: ReactNode;
	onPickPrompt: (prompt: string) => void;
}) {
	const { data: user } = useUserQuery();
	const firstName = user?.name?.trim().split(/\s+/)[0];
	const canEdit = canEditProject(project.your_role);
	const prompts = [
		{
			icon: Sparkles,
			title: 'Explore this project',
			prompt: 'Give me an overview of this project and what I can work on.',
		},
		{
			icon: BookOpen,
			title: 'Explain a notebook',
			prompt: 'Read a notebook in this project and explain its data transformations and outputs.',
		},
		...(canEdit
			? [
					{
						icon: NotebookPen,
						title: 'Create a notebook',
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
						prompt: 'Help me create a scheduled job for a notebook in this project.',
					},
				]
			: []),
	];
	return (
		<div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center py-12 sm:pb-24">
			<h1 className="mb-8 text-balance text-center text-3xl font-medium tracking-tight sm:text-4xl">
				What should we build{firstName ? `, ${firstName}` : ''}?
			</h1>
			{composer}
			<div className="mt-5 flex flex-wrap justify-center gap-2">
				{prompts.map(({ icon: Icon, title, prompt }) => (
					<Button
						key={title}
						variant="ghost"
						size="sm"
						onPress={() => onPickPrompt(prompt)}
						className="rounded-full bg-muted/60 text-xs font-normal text-muted-foreground"
					>
						<Icon className="size-3.5" aria-hidden />
						{title}
					</Button>
				))}
			</div>
		</div>
	);
}
