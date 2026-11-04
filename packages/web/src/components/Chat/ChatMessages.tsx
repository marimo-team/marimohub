import { Bot, MessageSquare } from 'lucide-react';
import type { ChatUIMessage } from '@/api/conversations';
import { cn } from '@/lib/utils';
import { AssistantMessage } from './AssistantMessage';
import { ToolActivity } from './ToolActivity';
import { messageBlocks } from './toolActivityModel';
import type { DecidePermission } from './PermissionCard';

function userText(message: ChatUIMessage): string {
	return message.parts
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('');
}

export function ChatMessages({
	messages,
	onDecide,
}: {
	messages: readonly ChatUIMessage[];
	onDecide: DecidePermission;
}) {
	return (
		<>
			{messages.map((message) => (
				<article
					key={message.id}
					id={`chat-message-${message.id}`}
					className="flex gap-4 border-b border-border/50 pb-6 last-of-type:border-b-0 last-of-type:pb-0"
				>
					<div
						className={cn(
							'mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg',
							message.role === 'assistant'
								? 'bg-primary/10 text-primary'
								: 'bg-muted text-muted-foreground',
						)}
					>
						{message.role === 'assistant' ? (
							<Bot className="size-4" aria-hidden />
						) : (
							<MessageSquare className="size-4" aria-hidden />
						)}
					</div>
					<div className="min-w-0 flex-1">
						<p className="mb-2 text-xs font-semibold">
							{message.role === 'user' ? 'You' : 'marimohub'}
						</p>
						{message.role === 'assistant' ? (
							messageBlocks(message).map((block) =>
								block.kind === 'text' ? (
									<AssistantMessage key={block.key} content={block.text} />
								) : (
									<ToolActivity key={block.key} calls={block.calls} onDecide={onDecide} />
								),
							)
						) : (
							<div className="whitespace-pre-wrap break-words text-sm leading-7">
								{userText(message)}
							</div>
						)}
					</div>
				</article>
			))}
		</>
	);
}
