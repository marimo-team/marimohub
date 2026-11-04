import type { ChatUIMessage, ConversationPermission } from '@/api/conversations';

export type ChatPart = ChatUIMessage['parts'][number];
export type ToolPart = Extract<ChatPart, { type: 'dynamic-tool' }>;
export type PermissionPart = Extract<ChatPart, { type: 'data-permission' }>;
export type ToolStatus = 'running' | 'succeeded' | 'failed';

export const TOOL_STATUS_LABELS: Record<ToolStatus, string> = {
	running: 'Running',
	succeeded: 'Completed',
	failed: 'Failed',
};

export function toolLabel(name: string): string {
	return name.replaceAll('_', ' ');
}

/** One line describing where a consent request ended up. */
export function permissionOutcome(permission: ConversationPermission): string {
	switch (permission.status) {
		case 'open':
			return 'Waiting for your answer';
		case 'allowed':
			return 'Allowed once';
		case 'remembered':
			return `Always allowed for ${permission.scope.label}`;
		case 'denied':
			return 'Not allowed';
		case 'expired':
			return 'No answer in time. Chat continued without it.';
		case 'cancelled':
			return 'Stopped';
		case 'unavailable':
			return 'This client cannot ask for permission.';
	}
}

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
		// A call refused at the consent gate still returns a normal output describing
		// the refusal, so the tool part alone would read as a success.
		const refused =
			permission !== undefined && permissionStatus(permission.data.status) === 'failed';
		return {
			id: part.toolCallId,
			name: part.toolName,
			status: refused ? 'failed' : toolStatus(part),
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
	const shown = new Set(
		message.parts.flatMap((part) => (isToolPart(part) ? [part.toolCallId] : [])),
	);
	const orphaned = permissions.filter((part) => !shown.has(part.data.tool_call_id));
	if (orphaned.length > 0)
		blocks.push({
			kind: 'tools',
			key: 'tools-orphaned',
			calls: orphaned.map((part) => ({
				id: part.data.tool_call_id,
				name: part.data.action,
				status: permissionStatus(part.data.status),
				permission: part.data,
			})),
		});
	return blocks;
}

function permissionStatus(status: ConversationPermission['status']): ToolStatus {
	switch (status) {
		case 'open':
			return 'running';
		case 'allowed':
		case 'remembered':
			return 'succeeded';
		case 'denied':
		case 'expired':
		case 'cancelled':
		case 'unavailable':
			return 'failed';
	}
}

/** Every call the transcript renders for this message, orphaned consent rows included. */
export function messageToolEntries(message: ChatUIMessage): ToolActivityEntry[] {
	return messageBlocks(message).flatMap((block) => (block.kind === 'tools' ? block.calls : []));
}

export interface ToolReference {
	kind: 'notebook' | 'job' | 'session';
	id: string;
}

const REFERENCE_PATTERNS: readonly [ToolReference['kind'], RegExp][] = [
	['notebook', /\bnb-[0-9a-z]{16}\b/g],
	['job', /\bjob-[0-9a-z]{16}\b/g],
	['session', /\bsess-[0-9a-z]{16}\b/g],
];

/** Hub resource ids mentioned in a call's saved input and result, so the UI can link them. */
export function toolReferences(entry: ToolActivityEntry): ToolReference[] {
	const text = `${entry.input_preview ?? ''}\n${entry.output_preview ?? ''}`;
	const seen = new Set<string>();
	const references: ToolReference[] = [];
	for (const [kind, pattern] of REFERENCE_PATTERNS)
		for (const match of text.matchAll(pattern)) {
			if (seen.has(match[0])) continue;
			seen.add(match[0]);
			references.push({ kind, id: match[0] });
		}
	return references;
}

export interface InspectedTool extends ToolActivityEntry {
	messageId: string;
	createdAt?: string;
}

export function findToolEntry(
	messages: readonly ChatUIMessage[],
	toolCallId: string,
): InspectedTool | undefined {
	for (const message of messages) {
		if (message.role !== 'assistant') continue;
		const entry = messageToolEntries(message).find((call) => call.id === toolCallId);
		if (entry) return { ...entry, messageId: message.id, createdAt: message.metadata?.created_at };
	}
	return undefined;
}
