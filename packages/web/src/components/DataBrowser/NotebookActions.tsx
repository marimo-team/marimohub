import { Check, Copy, NotebookPen } from 'lucide-react';
import { Button } from '@/components/ui';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { cn } from '@/lib/utils';
import { useSeededNotebook } from './notebookSeed';

export interface SeededNotebook {
	title: string;
	heading: string;
	description: string;
	snippet: string;
}

export function OpenInNotebookButton({
	projectId,
	notebook,
	label = 'Open in Notebook',
	className,
}: {
	projectId: string;
	notebook: SeededNotebook;
	label?: string;
	className?: string;
}) {
	const seededNotebook = useSeededNotebook(projectId);
	return (
		<Button
			variant="primary"
			className={className}
			onPress={() => void seededNotebook.create(notebook)}
			isDisabled={seededNotebook.isPending}
		>
			<NotebookPen className="size-4" aria-hidden />
			<span aria-live="polite">{seededNotebook.isPending ? 'Creating Notebook…' : label}</span>
		</Button>
	);
}

export function NotebookSnippet({
	snippet,
	title = 'Notebook Code',
	className,
}: {
	snippet: string;
	title?: string;
	className?: string;
}) {
	const { copied, copy } = useCopyToClipboard();
	return (
		<section className={cn('flex min-w-0 flex-col gap-2', className)}>
			<div className="flex min-h-9 items-center justify-between gap-3">
				<h3 className="text-sm font-medium text-foreground">{title}</h3>
				<Button variant="ghost" size="sm" onPress={() => void copy(snippet)}>
					{copied ? (
						<Check className="size-4 text-primary" aria-hidden />
					) : (
						<Copy className="size-4" aria-hidden />
					)}
					<span aria-live="polite">{copied ? 'Copied' : 'Copy Snippet'}</span>
				</Button>
			</div>
			<pre
				translate="no"
				className="max-h-96 overflow-auto rounded-lg border border-input bg-muted/40 p-4 font-mono text-xs leading-5"
			>
				<code>{snippet}</code>
			</pre>
		</section>
	);
}
