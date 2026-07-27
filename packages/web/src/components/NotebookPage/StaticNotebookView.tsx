import { Camera } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useNotebookHtmlQuery } from '@/api/hooks';
import { formatRelative } from '@/lib/time';

interface StaticNotebookViewProps {
	projectId: string;
	notebookId: string;
	title: string;
}

/**
 * What a viewer sees opening a notebook when their viewer mode grants no edit
 * kernel (MARIMOHUB_VIEWER_MODE=static or applications): the notebook's last
 * captured HTML snapshot (from a past editor session's teardown), or an empty
 * state when none exists yet. The snapshot is user-generated HTML, so it renders
 * in an iframe WITHOUT `allow-same-origin` — an opaque origin, unlike the
 * live-kernel iframe (the server's CSP `sandbox` header is the second layer).
 */
export function StaticNotebookView({ projectId, notebookId, title }: StaticNotebookViewProps) {
	const { data, isPending, isError } = useNotebookHtmlQuery(projectId, notebookId);

	if (isPending) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
				<div
					className={cn(
						'size-8 rounded-full border-[3px] border-border border-t-primary',
						'animate-spin',
					)}
				/>
				<p>Loading outputs...</p>
			</div>
		);
	}

	if (isError) {
		return (
			<div className="flex flex-1 items-center justify-center p-6 text-center">
				<p className="max-w-md text-sm text-destructive">Failed to load the notebook outputs.</p>
			</div>
		);
	}

	return (
		<>
			<div className="flex items-center gap-1.5 border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
				<Camera className="size-3.5 shrink-0" />
				<span>
					{data
						? `Static snapshot of outputs${data.capturedAt ? ` from ${formatRelative(data.capturedAt)}` : ''} — sessions are disabled for viewers.`
						: "You're a viewer on this project — sessions are disabled."}
				</span>
			</div>
			{data ? (
				<div className="flex-1 overflow-hidden">
					<iframe
						className="size-full border-0"
						srcDoc={data.html}
						sandbox="allow-scripts"
						title={title}
					/>
				</div>
			) : (
				<div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
					<p className="text-sm font-medium">No outputs yet</p>
					<p className="max-w-md text-sm text-muted-foreground">
						An editor needs to run this notebook before its outputs can be viewed.
					</p>
				</div>
			)}
		</>
	);
}
