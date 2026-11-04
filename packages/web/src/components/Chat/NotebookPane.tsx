import { useState } from 'react';
import { ExternalLink, Notebook } from 'lucide-react';
import { Button } from '@/components/ui';
import { SidePane } from './SidePane';
import { withBasePath } from '@/lib/basePath';

/**
 * The notebook shown beside a conversation. It embeds the hub's own notebook
 * page, so the session lifecycle, heartbeats, and editor claims behave exactly
 * as they do on the full page; the chat only decides which notebook is open.
 */
export function NotebookPane({
	pid,
	workingNotebook,
	notebooks,
	busy,
	width,
	onChange,
	onClose,
}: {
	pid: string;
	workingNotebook?: string;
	notebooks: readonly { id: string; title: string }[];
	busy: boolean;
	width: number;
	onChange: (notebookId: string | null) => Promise<unknown>;
	onClose: () => void;
}) {
	const [choice, setChoice] = useState(workingNotebook ?? notebooks[0]?.id ?? '');
	const [choosing, setChoosing] = useState(false);
	const [saving, setSaving] = useState(false);
	const current = notebooks.find((notebook) => notebook.id === workingNotebook);
	const projectPath = `/projects/${encodeURIComponent(pid)}`;
	const notebookPath = workingNotebook
		? `${projectPath}/notebooks/${encodeURIComponent(workingNotebook)}`
		: null;
	const choose = async (next: string | null) => {
		setSaving(true);
		try {
			await onChange(next);
			setChoosing(false);
		} finally {
			setSaving(false);
		}
	};
	const picker = (
		<form
			className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center"
			onSubmit={(event) => {
				event.preventDefault();
				if (choice) void choose(choice);
			}}
		>
			<Notebook className="size-8 text-muted-foreground" aria-hidden />
			<div>
				<p className="text-sm font-medium">Open a notebook beside this conversation</p>
				<p className="mt-1 text-xs text-muted-foreground">
					The assistant sees which notebook is open and can create a new one for you.
				</p>
			</div>
			{notebooks.length > 0 ? (
				<>
					<select
						aria-label="Notebook to open"
						value={choice}
						onChange={(event) => setChoice(event.target.value)}
						className="w-full max-w-xs rounded-md border bg-background px-2.5 py-1.5 text-[13px] max-md:min-h-11"
					>
						{notebooks.map((notebook) => (
							<option key={notebook.id} value={notebook.id}>
								{notebook.title}
							</option>
						))}
					</select>
					<div className="flex gap-2">
						<Button type="submit" variant="primary" isDisabled={!choice || saving}>
							Open notebook
						</Button>
						{workingNotebook ? (
							<Button type="button" isDisabled={saving} onPress={() => setChoosing(false)}>
								Cancel
							</Button>
						) : null}
					</div>
				</>
			) : (
				<p className="text-sm text-muted-foreground">
					This project has no notebooks yet. Ask the assistant to create one.
				</p>
			)}
		</form>
	);
	return (
		<SidePane
			label="Notebook pane"
			width={width}
			className="min-h-[60vh]"
			closeLabel="Close notebook pane"
			onClose={onClose}
			title={
				<div className="flex min-w-0 items-center gap-2 py-1.5 text-xs">
					<Notebook className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
					<span className="truncate font-medium">
						{current?.title ?? (workingNotebook ? 'Notebook' : 'No notebook open')}
					</span>
				</div>
			}
			actions={
				workingNotebook && !choosing ? (
					<>
						<Button
							size="sm"
							variant="ghost"
							isDisabled={busy || saving}
							onPress={() => setChoosing(true)}
						>
							Change
						</Button>
						<a
							href={withBasePath(notebookPath!)}
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center gap-1 rounded-sm px-2 py-1 max-md:min-h-11 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
						>
							Open full page <ExternalLink className="size-3" aria-hidden />
						</a>
					</>
				) : null
			}
		>
			{notebookPath && !choosing ? (
				<iframe
					key={workingNotebook}
					title={`Notebook ${current?.title ?? workingNotebook}`}
					src={withBasePath(notebookPath)}
					className="min-h-0 flex-1 border-0 bg-background"
				/>
			) : (
				picker
			)}
		</SidePane>
	);
}
