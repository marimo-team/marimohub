import type { RefObject } from 'react';
import { ArrowUp, ListPlus, Square } from 'lucide-react';
import { Button } from '@/components/ui';
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
}: {
	home: boolean;
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
		<div className={cn('mx-auto w-full', home ? 'max-w-4xl' : 'max-w-3xl')}>
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
					'flex items-end gap-3 rounded-3xl border border-input bg-background shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30',
					home ? 'px-5 py-4' : 'px-4 py-3',
				)}
			>
				<textarea
					ref={composer}
					id="chat-message"
					aria-label="Message the project assistant"
					value={draft}
					onChange={(event) => onDraftChange(event.target.value)}
					rows={1}
					maxLength={MAX_MESSAGE_CHARACTERS}
					placeholder={queueing ? 'Queue the next message…' : 'What can I help you with?'}
					className="max-h-36 min-h-7 min-w-0 flex-1 resize-none bg-transparent py-1 text-sm leading-6 outline-none placeholder:text-muted-foreground"
					onKeyDown={(event) => {
						if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							onSubmit();
						}
					}}
				/>
				{onStop && !draft.trim() ? (
					<Button
						type="button"
						variant="unstyled"
						onPress={onStop}
						aria-label="Stop response"
						className="flex size-8 shrink-0 items-center justify-center rounded-full text-destructive outline-none hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring"
					>
						<Square className="size-4 fill-current" aria-hidden />
					</Button>
				) : (
					<Button
						type="submit"
						variant="unstyled"
						isDisabled={!draft.trim() || !canSubmit}
						aria-label={queueing ? 'Queue message' : 'Send message'}
						className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background outline-none hover:bg-foreground/80 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-35"
					>
						{queueing ? (
							<ListPlus className="size-5" aria-hidden />
						) : (
							<ArrowUp className="size-5" aria-hidden />
						)}
					</Button>
				)}
			</form>
			<div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
				{home ? <span>Uses your project permissions · changes ask for consent</span> : null}
				<span>
					{queueing
						? 'Enter to queue · the button stops the response while the box is empty'
						: 'Enter to send · Shift + Enter for a new line'}
				</span>
			</div>
		</div>
	);
}
