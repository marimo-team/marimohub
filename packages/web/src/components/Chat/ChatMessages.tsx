import { useId, useState } from 'react';
import { Check, ChevronRight, Copy, LoaderCircle, Pencil } from 'lucide-react';
import type { ChatUIMessage } from '@/api/conversations';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { formatAbsolute } from '@/lib/time';
import { cn } from '@/lib/utils';
import { AssistantMessage } from './AssistantMessage';
import { ToolActivity } from './ToolActivity';
import { messageBlocks } from './toolActivityModel';
import type { MessageBlock } from './toolActivityModel';
import type { DecidePermission } from './PermissionCard';

type ActivityProps = {
	onDecide: DecidePermission;
	onInspect?: (toolCallId: string) => void;
	inspecting?: string | null;
};

function messageText(message: ChatUIMessage): string {
	return message.parts
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('\n\n');
}

function Blocks({ blocks, ...activity }: ActivityProps & { blocks: readonly MessageBlock[] }) {
	return blocks.map((block) =>
		block.kind === 'text' ? (
			<AssistantMessage key={block.key} content={block.text} />
		) : (
			<ToolActivity key={block.key} calls={block.calls} {...activity} />
		),
	);
}

function Work({
	blocks,
	active,
	...activity
}: ActivityProps & { blocks: readonly MessageBlock[]; active: boolean }) {
	const [expanded, setExpanded] = useState(() =>
		blocks.some(
			(block) =>
				block.kind === 'tools' && block.calls.some((call) => call.id === activity.inspecting),
		),
	);
	const id = useId();
	const calls = blocks.flatMap((block) => (block.kind === 'tools' ? block.calls : []));
	const failed = calls.filter((call) => call.status === 'failed').length;
	const waiting = calls.some((call) => call.permission?.status === 'open');
	const open = active || expanded;
	return (
		<section aria-label="Assistant work" className="mb-4">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={id}
				aria-disabled={active}
				onClick={() => {
					if (!active) setExpanded(!open);
				}}
				className="flex w-full items-center gap-2 border-b border-border/60 pb-2 max-md:min-h-11 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
			>
				{active ? (
					<LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
				) : null}
				<span>
					{waiting ? 'Waiting for permission' : active ? 'Working' : 'Worked'} · {calls.length}{' '}
					{calls.length === 1 ? 'step' : 'steps'}
				</span>
				{failed > 0 ? (
					<span className="text-destructive">
						{' · '}
						{failed} failed
					</span>
				) : null}
				<ChevronRight className={cn('size-3.5', open && 'rotate-90')} aria-hidden />
			</button>
			<div id={id} hidden={!open} className="space-y-3 border-l border-border/60 pl-3 pt-3">
				<Blocks blocks={blocks} {...activity} />
			</div>
		</section>
	);
}

function AssistantReply({ message, ...activity }: ActivityProps & { message: ChatUIMessage }) {
	const blocks = messageBlocks(message);
	const lastTool = blocks.findLastIndex((block) => block.kind === 'tools');
	const work = blocks.slice(0, lastTool + 1);
	const active = work.some(
		(block) =>
			block.kind === 'tools' &&
			block.calls.some((call) => call.status === 'running' || call.permission?.status === 'open'),
	);
	return (
		<>
			{work.length > 0 ? (
				<Work key={active ? 'active' : 'settled'} blocks={work} active={active} {...activity} />
			) : null}
			<div className="space-y-4">
				<Blocks blocks={blocks.slice(lastTool + 1)} {...activity} />
			</div>
		</>
	);
}

function Message({
	message,
	onReuse,
	canReuse,
	...activity
}: ActivityProps & {
	message: ChatUIMessage;
	onReuse?: (text: string) => void;
	canReuse: boolean;
}) {
	const { copied, copy } = useCopyToClipboard();
	const text = messageText(message);
	const user = message.role === 'user';
	const createdAt = message.metadata?.created_at;
	const actionClass =
		'flex size-7 max-md:size-11 items-center justify-center rounded-full outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40';
	return (
		<article
			id={`chat-message-${message.id}`}
			aria-label={user ? 'Your message' : 'Assistant message'}
			className={cn('group/message min-w-0', user && 'flex flex-col items-end')}
		>
			{user ? (
				<div className="max-w-[90%] whitespace-pre-wrap [overflow-wrap:anywhere] rounded-3xl rounded-br-lg bg-blue-50 px-4 py-2.5 text-sm leading-6 text-blue-950 dark:bg-blue-400/15 dark:text-blue-100 sm:max-w-[85%]">
					{text}
				</div>
			) : (
				<AssistantReply message={message} {...activity} />
			)}
			{text ? (
				<div
					className={cn(
						'mt-1 flex min-h-8 items-center gap-1 text-muted-foreground transition-opacity group-focus-within/message:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/message:opacity-100',
						user && 'justify-end',
					)}
				>
					{createdAt ? (
						<time dateTime={createdAt} className="mr-2 text-[11px]">
							{formatAbsolute(createdAt)}
						</time>
					) : null}
					<button
						type="button"
						aria-label={copied ? 'Copied message' : 'Copy message'}
						title={copied ? 'Copied' : 'Copy message'}
						onClick={() => void copy(text)}
						className={actionClass}
					>
						{copied ? (
							<Check className="size-3.5" aria-hidden />
						) : (
							<Copy className="size-3.5" aria-hidden />
						)}
					</button>
					{user && onReuse ? (
						<button
							type="button"
							aria-label="Use message as draft"
							title={canReuse ? 'Use message as draft' : 'Clear your draft to reuse this message'}
							disabled={!canReuse}
							onClick={() => onReuse(text)}
							className={actionClass}
						>
							<Pencil className="size-3.5" aria-hidden />
						</button>
					) : null}
				</div>
			) : null}
		</article>
	);
}

export function ChatMessages({
	messages,
	onReuse,
	canReuse = true,
	...activity
}: ActivityProps & {
	messages: readonly ChatUIMessage[];
	onReuse?: (text: string) => void;
	canReuse?: boolean;
}) {
	return messages.map((message) => (
		<Message
			key={message.id}
			message={message}
			onReuse={onReuse}
			canReuse={canReuse}
			{...activity}
		/>
	));
}
