import type { ChatUIMessage, ConversationPermission } from '@/api/conversations';

export type ChatPart = ChatUIMessage['parts'][number];
export type ToolPart = Extract<ChatPart, { type: 'dynamic-tool' }>;
export type PermissionPart = Extract<ChatPart, { type: 'data-permission' }>;
export type ToolStatus = 'running' | 'succeeded' | 'failed';

export interface ToolActivityEntry {
	id: string;
	name: string;
	status: ToolStatus;
	summary?: string;
	input_preview?: string;
	output_preview?: string;
	permission?: ConversationPermission;
}

export function isToolPart(part: ChatPart): part is ToolPart {
	return part.type === 'dynamic-tool';
}

export function isPermissionPart(part: ChatPart): part is PermissionPart {
	return part.type === 'data-permission';
}

export function toolStatus(part: ToolPart): ToolStatus {
	if (part.state === 'output-available') return 'succeeded';
	if (part.state === 'output-error' || part.state === 'output-denied') return 'failed';
	return 'running';
}

function preview(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/** Tool parts with the latest consent card for each call attached. */
export function toolEntries(
	parts: readonly ToolPart[],
	permissions: readonly PermissionPart[] = [],
): ToolActivityEntry[] {
	return parts.map((part) => {
		const permission = permissions.findLast((item) => item.data.tool_call_id === part.toolCallId);
		return {
			id: part.toolCallId,
			name: part.toolName,
			status: toolStatus(part),
			summary: part.state === 'output-error' ? part.errorText : undefined,
			input_preview: preview(part.input),
			output_preview: preview(part.output),
			permission: permission?.data,
		};
	});
}

export type MessageBlock =
	| { kind: 'text'; key: string; text: string }
	| { kind: 'tools'; key: string; calls: ToolActivityEntry[] };

/**
 * Group an assistant message's parts into alternating text and tool blocks,
 * preserving order so tool activity appears where it happened in the reply.
 */
export function messageBlocks(message: ChatUIMessage): MessageBlock[] {
	const permissions = message.parts.filter(isPermissionPart);
	const blocks: MessageBlock[] = [];
	let text = '';
	let tools: ToolPart[] = [];
	const flushText = () => {
		const trimmed = text.trim();
		if (trimmed) blocks.push({ kind: 'text', key: `text-${blocks.length}`, text: trimmed });
		text = '';
	};
	const flushTools = () => {
		if (tools.length > 0)
			blocks.push({
				kind: 'tools',
				key: `tools-${blocks.length}`,
				calls: toolEntries(tools, permissions),
			});
		tools = [];
	};
	for (const part of message.parts) {
		if (part.type === 'text') {
			flushTools();
			text += text && part.text ? `\n\n${part.text}` : part.text;
		} else if (isToolPart(part)) {
			flushText();
			tools.push(part);
		}
	}
	flushTools();
	flushText();
	// A consent card whose tool call never streamed (for example after a reload
	// that lost the tool part) still deserves a place in the transcript.
	const shown = new Set(message.parts.filter(isToolPart).map((part) => part.toolCallId));
	const orphaned = permissions.filter((part) => !shown.has(part.data.tool_call_id));
	if (orphaned.length > 0)
		blocks.push({
			kind: 'tools',
			key: 'tools-orphaned',
			calls: orphaned.map((part) => ({
				id: part.data.tool_call_id,
				name: part.data.action,
				status: part.data.status === 'open' ? 'running' : 'succeeded',
				permission: part.data,
			})),
		});
	return blocks;
}

export function messageToolEntries(message: ChatUIMessage): ToolActivityEntry[] {
	return toolEntries(message.parts.filter(isToolPart), message.parts.filter(isPermissionPart));
}
