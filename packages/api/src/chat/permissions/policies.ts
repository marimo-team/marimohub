import type { ConversationPermission } from '@marimo-hub/core/chat';

export type PermissionRequest = Pick<
	ConversationPermission,
	'kind' | 'action' | 'details' | 'scope' | 'can_remember'
>;

export interface GatedTool {
	name: string;
	annotations?: {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		idempotentHint?: boolean;
	};
}

type Detail = ConversationPermission['details'][number];

/** Every tool that can change something asks first; read-only tools run freely. */
export function isGated(tool: GatedTool): boolean {
	return tool.annotations?.readOnlyHint !== true;
}

function scalar(value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return undefined;
}

/** Code the user is asked to approve must be readable in full; other fields stay short. */
const DETAIL_LIMITS = { code: 4000, other: 300 } as const;

function detail(
	label: string,
	value: unknown,
	limit: number = DETAIL_LIMITS.other,
): Detail | undefined {
	const text = scalar(value);
	return text === undefined || text === '' ? undefined : { label, value: text.slice(0, limit) };
}

function details(...entries: (Detail | undefined)[]): Detail[] {
	return entries.filter((entry): entry is Detail => entry !== undefined).slice(0, 6);
}

function humanize(name: string): string {
	return name.replaceAll('_', ' ');
}

/** Labels for the hub's own tools; anything else gets a generic card. */
const ACTIONS: Record<
	string,
	{ action: string; label: string; fields: [string, string, number?][]; remember?: false }
> = {
	create_notebook: {
		action: 'Create a notebook',
		label: 'creating notebooks',
		fields: [
			['Title', 'title'],
			['Code', 'code', DETAIL_LIMITS.code],
		],
	},
	update_notebook: {
		action: 'Change a notebook',
		label: 'changing notebooks',
		fields: [
			['Notebook', 'notebook'],
			['Title', 'title'],
			['Status', 'status'],
			['Code', 'code', DETAIL_LIMITS.code],
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
		fields: [
			['Notebook', 'notebook'],
			['Session', 'session'],
		],
	},
	execute_code: {
		action: 'Run code in a notebook session',
		label: 'running code',
		fields: [
			['Notebook', 'notebook'],
			['Code', 'code', DETAIL_LIMITS.code],
		],
		// Arbitrary code is never a standing grant.
		remember: false,
	},
	create_job: {
		action: 'Create a job',
		label: 'creating jobs',
		fields: [['Notebook', 'notebook']],
	},
	schedule_job: {
		action: 'Change a job schedule',
		label: 'changing job schedules',
		fields: [['Job', 'job']],
	},
	run_job: { action: 'Run a job', label: 'running jobs', fields: [['Job', 'job']] },
};

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
