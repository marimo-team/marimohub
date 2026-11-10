import { CHAT_LIMITS } from '@marimo-hub/core/chat';
import type { ConversationPermission } from '@marimo-hub/core/chat';

export type PermissionRequest = Pick<
	ConversationPermission,
	'kind' | 'action' | 'details' | 'scope' | 'can_remember'
>;

export interface GatedTool {
	name: string;
	consentInput?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
	annotations?: {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		idempotentHint?: boolean;
	};
}

type Detail = ConversationPermission['details'][number];

/**
 * Read-only for MCP clients, but they can start preview compute and send row or
 * object content to the model provider, so chat asks first.
 */
const DATA_PREVIEW_TOOLS: ReadonlySet<string> = new Set(['preview_table', 'preview_object']);

/** Every tool that can change something or send previewed data asks first; other reads run freely. */
export function isGated(tool: GatedTool): boolean {
	return tool.annotations?.readOnlyHint !== true || DATA_PREVIEW_TOOLS.has(tool.name);
}

/** Code the user is asked to approve must be readable in full; other fields stay short. */
const DETAIL_LIMITS = { code: CHAT_LIMITS.consentDetailCharacters, other: 2000 } as const;
const LABEL_LIMIT = 40;
const TRUNCATED = '\n… [truncated]';

function render(value: unknown): string | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return undefined;
	}
}

/** Over-cap values end in a visible marker so nobody approves text they could not see. */
function clamp(text: string, limit: number): string {
	return text.length <= limit ? text : text.slice(0, limit - TRUNCATED.length) + TRUNCATED;
}

function detail(
	label: string,
	value: unknown,
	limit: number = DETAIL_LIMITS.other,
): Detail | undefined {
	const text = render(value);
	return text === undefined
		? undefined
		: { label: label.slice(0, LABEL_LIMIT), value: clamp(text, limit) };
}

function details(...entries: (Detail | undefined)[]): Detail[] {
	return entries.filter((entry): entry is Detail => entry !== undefined).slice(0, 8);
}

function humanize(name: string): string {
	return name.replaceAll('_', ' ');
}

/** Labels for the hub's own tools; anything else gets a generic card. */
const ACTIONS: Record<
	string,
	{ action: string; label: string; fields: [string, string, number?][]; remember?: false }
> = {
	create_branch_notebook: {
		action: 'Create a remote working branch',
		label: 'creating working branches',
		remember: false,
		fields: [
			['Title', 'title'],
			['Repository', 'repo'],
			['Base branch', 'base_branch'],
			['Notebook file', 'entry_notebook'],
			['Start a session', 'launch'],
		],
	},
	save_to_branch: {
		action: 'Commit notebook changes to Git',
		label: 'committing working branch changes',
		fields: [
			['Notebook', 'notebook'],
			['Repository', 'repo'],
			['Working branch', 'branch'],
			['Session', 'session_id'],
			['Commit message', 'message'],
		],
	},
	open_change_request: {
		action: 'Open the working branch pull request',
		label: 'opening working branch pull requests',
		fields: [
			['Notebook', 'notebook'],
			['Repository', 'repo'],
			['Working branch', 'branch'],
			['Base branch', 'base_branch'],
			['Title', 'title'],
			['Draft', 'draft'],
		],
	},
	retry_branch_save: {
		action: 'Resume a captured branch save',
		label: 'resuming working branch saves',
		fields: [
			['Notebook', 'notebook'],
			['Repository', 'repo'],
			['Working branch', 'branch'],
			['Save operation', 'save_id'],
		],
	},
	create_notebook: {
		action: 'Create a notebook',
		label: 'creating notebooks',
		fields: [
			['Title', 'title'],
			['Description', 'description'],
			['Tags', 'tags'],
			['Readme', 'readme', DETAIL_LIMITS.code],
			['Code', 'code', DETAIL_LIMITS.code],
			['Start a session', 'launch'],
		],
	},
	update_notebook: {
		action: 'Change a notebook',
		label: 'changing notebooks',
		fields: [
			['Notebook', 'notebook'],
			['Title', 'title'],
			['Description', 'description'],
			['Tags', 'tags'],
			['Readme', 'readme', DETAIL_LIMITS.code],
			['Code', 'code', DETAIL_LIMITS.code],
			['Version message', 'message'],
		],
	},
	sync_notebook_source: {
		action: 'Sync notebook source from Git',
		label: 'syncing notebook sources',
		fields: [['Notebook', 'notebook']],
	},
	delete_notebook: {
		action: 'Delete a notebook',
		label: 'deleting notebooks',
		fields: [['Notebook', 'notebook']],
	},
	start_session: {
		action: 'Start a notebook session',
		label: 'starting sessions',
		fields: [
			['Notebook', 'notebook'],
			['Mode', 'mode'],
		],
	},
	stop_session: {
		action: 'Stop a notebook session',
		label: 'stopping sessions',
		fields: [['Session', 'session_id']],
	},
	execute_code: {
		action: 'Run code in a notebook session',
		label: 'running code',
		fields: [
			['Session', 'session_id'],
			['Code', 'code', DETAIL_LIMITS.code],
		],
		// Arbitrary code is never a standing grant.
		remember: false,
	},
	create_job: {
		action: 'Create a job',
		label: 'creating jobs',
		fields: [
			['Notebook', 'notebook'],
			['Name', 'name'],
			['Schedule', 'schedule'],
			['Enabled', 'enabled'],
			['Parameters', 'parameters'],
			['Concurrency', 'concurrency_policy'],
		],
	},
	schedule_job: {
		action: 'Change a job schedule',
		label: 'changing job schedules',
		fields: [
			['Job', 'job'],
			['Schedule', 'schedule'],
			['Enabled', 'enabled'],
		],
	},
	preview_table: {
		action: 'Preview table rows',
		label: 'previewing table rows',
		fields: [
			['Integration', 'integration'],
			['Namespace', 'namespace'],
			['Table', 'table'],
			['Rows', 'limit'],
		],
	},
	preview_object: {
		action: 'Preview object content',
		label: 'previewing object content',
		fields: [
			['Integration', 'integration'],
			['Bucket', 'bucket'],
			['Key', 'key'],
			['Version', 'version_id'],
			['Rows', 'limit'],
		],
	},
	run_job: {
		action: 'Run a job',
		label: 'running jobs',
		fields: [
			['Job', 'job'],
			['Parameters', 'parameters'],
		],
	},
};

/**
 * A code-like field too long for its card. Approval covers the whole input, so
 * such a call is refused before it reaches the gate instead of shown truncated.
 */
export function oversizedDetail(
	tool: GatedTool,
	input: Record<string, unknown>,
): { label: string; limit: number } | undefined {
	if (!isGated(tool)) return undefined;
	for (const [label, key, limit] of ACTIONS[tool.name]?.fields ?? []) {
		if (limit === undefined) continue;
		const text = render(input[key]);
		if (text !== undefined && text.length > limit) return { label, limit };
	}
	return undefined;
}

/** Build the consent card for one gated call, or nothing when the tool runs freely. */
export function permissionRequest(
	tool: GatedTool,
	input: Record<string, unknown>,
): PermissionRequest | undefined {
	if (!isGated(tool)) return undefined;
	const known = ACTIONS[tool.name];
	const fields = known
		? known.fields.map(([label, key, limit]) => detail(label, input[key], limit))
		: Object.entries(input)
				.filter(([key]) => key !== 'project')
				.slice(0, 6)
				.map(([key, value]) => detail(humanize(key), value));
	return {
		kind: 'tool',
		action: known?.action ?? `Run ${humanize(tool.name)}`.slice(0, 120),
		details: details(...fields),
		scope: {
			key: `tool:${tool.name}`.slice(0, 200),
			label: `${known?.label ?? humanize(tool.name)} in this project`.slice(0, 120),
		},
		// Irreversible actions and arbitrary code ask every time; a remembered grant would hide them.
		can_remember: tool.annotations?.destructiveHint !== true && known?.remember !== false,
	};
}
