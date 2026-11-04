import { Check, Copy, ExternalLink, Notebook } from 'lucide-react';
import { Button } from '@/components/ui';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { withBasePath } from '@/lib/basePath';
import { formatAbsolute } from '@/lib/time';
import { cn } from '@/lib/utils';
import { SidePane } from './SidePane';
import {
	permissionOutcome,
	TOOL_STATUS_LABELS,
	toolLabel,
	toolReferences,
} from './toolActivityModel';
import type { InspectedTool, ToolReference, ToolStatus } from './toolActivityModel';

const STATUS_CLASS: Record<ToolStatus, string> = {
	running: 'bg-primary/10 text-primary',
	succeeded: 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300',
	failed: 'bg-destructive/10 text-destructive',
};

const newTabLink =
	'inline-flex items-center gap-1 rounded-md px-2 py-1 max-md:min-h-11 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary';

function Block({ title, value }: { title: string; value?: string }) {
	const { copied, copy } = useCopyToClipboard();
	return (
		<section aria-label={title} className="space-y-2">
			<div className="flex items-center justify-between gap-2">
				<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
					{title}
				</h3>
				{value ? (
					<Button
						variant="ghost"
						size="sm"
						aria-label={copied ? `Copied ${title}` : `Copy ${title}`}
						onPress={() => void copy(value)}
					>
						{copied ? (
							<Check className="size-3.5" aria-hidden />
						) : (
							<Copy className="size-3.5" aria-hidden />
						)}
					</Button>
				) : null}
			</div>
			{value ? (
				<pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-5">
					{value}
				</pre>
			) : (
				<p className="text-xs text-muted-foreground">Nothing saved for this call.</p>
			)}
		</section>
	);
}

function ReferenceRow({
	reference,
	pid,
	notebooks,
	onShowNotebook,
}: {
	reference: ToolReference;
	pid: string;
	notebooks: readonly { id: string; title: string }[];
	onShowNotebook?: (notebookId: string) => void;
}) {
	const projectPath = `/projects/${encodeURIComponent(pid)}`;
	const title = notebooks.find((notebook) => notebook.id === reference.id)?.title;
	const href =
		reference.kind === 'notebook'
			? `${projectPath}/notebooks/${encodeURIComponent(reference.id)}`
			: reference.kind === 'job'
				? `${projectPath}/jobs`
				: null;
	return (
		<li className="flex items-center justify-between gap-3 py-2">
			<div className="min-w-0">
				<p className="truncate text-[13px]">{title ?? reference.id}</p>
				<p className="truncate font-mono text-[11px] text-muted-foreground">
					{reference.kind}
					{title ? ` · ${reference.id}` : ''}
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-1">
				{reference.kind === 'notebook' && onShowNotebook ? (
					<Button size="sm" variant="ghost" onPress={() => onShowNotebook(reference.id)}>
						<Notebook className="size-3.5" aria-hidden />
						Show beside chat
					</Button>
				) : null}
				{href ? (
					<a
						href={withBasePath(href)}
						target="_blank"
						rel="noopener noreferrer"
						aria-label={`Open ${title ?? reference.id} in a new tab`}
						className={newTabLink}
					>
						<ExternalLink className="size-3.5" aria-hidden />
						New tab
					</a>
				) : null}
			</div>
		</li>
	);
}

/**
 * Drill-down for one tool call: what the assistant asked for, what came back,
 * whether the user consented, and the hub resources it touched. Everything shown
 * is the redacted record, so this is safe to share by URL.
 */
export function ContextInspector({
	pid,
	entry,
	notebooks,
	permalink,
	width,
	onShowNotebook,
	onClose,
}: {
	pid: string;
	entry: InspectedTool;
	notebooks: readonly { id: string; title: string }[];
	/** Same-app URL that reopens this inspector, for a new tab. */
	permalink: string;
	width: number;
	onShowNotebook?: (notebookId: string) => void;
	onClose: () => void;
}) {
	const references = toolReferences(entry);
	return (
		<SidePane
			label="Tool call details"
			width={width}
			closeLabel="Close details"
			onClose={onClose}
			title={
				<>
					<h2 className="truncate text-[13px] font-semibold capitalize">{toolLabel(entry.name)}</h2>
					<p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
						<span
							className={cn('rounded-md px-1.5 py-0.5 font-medium', STATUS_CLASS[entry.status])}
						>
							{TOOL_STATUS_LABELS[entry.status]}
						</span>
						{entry.createdAt ? <span>{formatAbsolute(entry.createdAt)}</span> : null}
						<span className="font-mono">{entry.name}</span>
					</p>
				</>
			}
			actions={
				<a
					href={withBasePath(permalink)}
					target="_blank"
					rel="noopener noreferrer"
					aria-label="Open details in a new tab"
					className={cn(newTabLink, 'size-8 max-md:size-11 justify-center px-0')}
				>
					<ExternalLink className="size-4" aria-hidden />
				</a>
			}
		>
			<div className="min-h-0 flex-1 space-y-4 overflow-auto p-3">
				{entry.permission ? (
					<section aria-label="Permission" className="rounded-md border p-3 text-sm">
						<p className="font-medium">{entry.permission.action}</p>
						<p className="mt-1 text-xs text-muted-foreground">
							{permissionOutcome(entry.permission)}
						</p>
					</section>
				) : null}
				{entry.summary ? (
					<p role="note" className="text-sm text-destructive">
						{entry.summary}
					</p>
				) : null}
				<Block title="Input" value={entry.input_preview} />
				<Block
					title={entry.status === 'failed' ? 'Error' : 'Result'}
					value={entry.output_preview}
				/>
				{references.length > 0 ? (
					<section aria-label="Referenced resources">
						<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
							Referenced
						</h3>
						<ul className="mt-1 divide-y">
							{references.map((reference) => (
								<ReferenceRow
									key={`${reference.kind}:${reference.id}`}
									reference={reference}
									pid={pid}
									notebooks={notebooks}
									onShowNotebook={onShowNotebook}
								/>
							))}
						</ul>
					</section>
				) : null}
				<p className="text-xs text-muted-foreground">
					Previews are redacted: credentials, code, and large payloads are left out of the saved
					record.
				</p>
			</div>
		</SidePane>
	);
}

/** The URL named a call this conversation does not contain (deleted, mistyped, or another chat). */
export function MissingInspector({ width, onClose }: { width: number; onClose: () => void }) {
	return (
		<SidePane
			label="Tool call details"
			width={width}
			closeLabel="Close details"
			onClose={onClose}
			title={<h2 className="text-sm font-semibold">Tool call details</h2>}
		>
			<div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
				<p className="text-sm font-medium">This tool call is not in this conversation.</p>
				<p className="text-xs text-muted-foreground">
					The link may point at another conversation, or the call was never saved.
				</p>
				<Button size="sm" className="mt-2" onPress={onClose}>
					Close
				</Button>
			</div>
		</SidePane>
	);
}
