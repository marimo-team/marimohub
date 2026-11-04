import type { RefObject } from 'react';
import { ArrowUp, ListPlus, Notebook, Plus, Square } from 'lucide-react';
import { Button, DropdownMenu } from '@/components/ui';
import { cn } from '@/lib/utils';

export const MAX_MESSAGE_CHARACTERS = 8000;

export function ChatComposer({
	home,
	error,
	composer,
	draft,
	onDraftChange,
	onSubmit,
	canSubmit,
	queueing = false,
	onStop,
	onToggleNotebook,
	notebookTitle,
	notebookOpen,
	notebookDisabled,
}: {
	home: boolean;
	onToggleNotebook: () => void;
	notebookTitle?: string;
	notebookOpen: boolean;
	notebookDisabled: boolean;
	error?: string | null;
	composer: RefObject<HTMLTextAreaElement | null>;
	draft: string;
	onDraftChange: (draft: string) => void;
	onSubmit: () => void;
	canSubmit: boolean;
	/** A turn is running, so a submitted message waits in the queue until it ends. */
	queueing?: boolean;
	/** Present while a turn runs in this tab; stops it. */
	onStop?: () => void;
}) {
	return (
		<div className="mx-auto w-full max-w-3xl">
			{error ? (
				<p role="alert" className="mb-3 text-sm text-destructive">
					{error}
				</p>
			) : null}
			<form
				onSubmit={(event) => {
					event.preventDefault();
					onSubmit();
				}}
				className={cn(
					'flex flex-col gap-2 rounded-2xl border border-input bg-background transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30',
					home ? 'px-4 py-3' : 'px-3 py-2',
				)}
			>
				<textarea
					ref={composer}
					id="chat-message"
					aria-label="Message the project assistant"
					value={draft}
					onChange={(event) => onDraftChange(event.target.value)}
					rows={home ? 2 : 1}
					maxLength={MAX_MESSAGE_CHARACTERS}
					placeholder={queueing ? 'Queue the next message…' : 'What can I help you with?'}
					className="max-h-36 min-h-7 w-full min-w-0 resize-none bg-transparent py-1 text-sm leading-6 outline-none placeholder:text-muted-foreground"
					onKeyDown={(event) => {
						if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							onSubmit();
						}
					}}
				/>
				<div className="flex items-center justify-between gap-3">
					<div className="flex min-w-0 items-center gap-2">
						<DropdownMenu
							label="Add context"
							placement="top start"
							icon={<Plus className="size-5" aria-hidden />}
							triggerClassName="size-8 shrink-0 rounded-full max-md:size-11"
							isDisabled={notebookDisabled}
							options={[
								{
									id: 'notebook',
									label: notebookOpen ? 'Hide notebook pane' : 'Open notebook beside chat',
									icon: <Notebook className="size-4" aria-hidden />,
								},
							]}
							onAction={onToggleNotebook}
						/>
						{notebookTitle ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								isDisabled={notebookDisabled}
								onPress={onToggleNotebook}
								aria-label={`${notebookOpen ? 'Hide' : 'Show'} notebook ${notebookTitle}`}
								aria-pressed={notebookOpen}
								className="min-w-0 gap-1.5 rounded-full bg-muted/60 font-normal"
							>
								<Notebook className="size-3.5 shrink-0" aria-hidden />
								<span className="truncate" title={notebookTitle}>
									{notebookTitle}
								</span>
							</Button>
						) : null}
					</div>
					<div className="flex shrink-0 items-center gap-1">
						{onStop ? (
							<Button
								type="button"
								variant="unstyled"
								onPress={onStop}
								aria-label="Stop response"
								className="flex size-8 max-md:size-11 shrink-0 items-center justify-center rounded-full text-destructive outline-none hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring"
							>
								<Square className="size-4 fill-current" aria-hidden />
							</Button>
						) : null}
						{!onStop || draft.trim() ? (
							<Button
								type="submit"
								variant="unstyled"
								isDisabled={!draft.trim() || !canSubmit}
								aria-label={queueing ? 'Queue message' : 'Send message'}
								className="flex size-8 max-md:size-11 shrink-0 items-center justify-center rounded-full bg-foreground text-background outline-none hover:bg-foreground/80 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-35"
							>
								{queueing ? (
									<ListPlus className="size-5" aria-hidden />
								) : (
									<ArrowUp className="size-5" aria-hidden />
								)}
							</Button>
						) : null}
					</div>
				</div>
			</form>
			<div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
				<span>
					{queueing
						? 'Enter to queue · stop ends the current response'
						: 'Enter to send · Shift + Enter for a new line'}
				</span>
			</div>
		</div>
	);
}
