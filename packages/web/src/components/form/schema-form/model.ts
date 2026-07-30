/** Mirrors core's JSON Schema keyword for secret-bearing fields. */
export const SECRET_MARK = 'x-marimohub-secret';

export interface JsonSchemaNode {
	type?: string;
	properties?: Record<string, JsonSchemaNode>;
	required?: string[];
	oneOf?: JsonSchemaNode[];
	anyOf?: JsonSchemaNode[];
	items?: JsonSchemaNode;
	additionalProperties?: JsonSchemaNode | boolean;
	propertyNames?: { pattern?: string };
	enum?: unknown[];
	const?: unknown;
	default?: unknown;
	description?: string;
	minimum?: number;
	maximum?: number;
	minLength?: number;
	pattern?: string;
	[SECRET_MARK]?: boolean;
}

export interface FieldHint {
	widget?: 'text' | 'password' | 'textarea' | 'select' | 'toggle' | 'number' | 'kv-pairs';
	placeholder?: string;
	group?: string;
	order?: number;
	advanced?: boolean;
	docs_url?: string;
}

export type UiHints = Record<string, FieldHint | undefined>;

/** Submitted for an untouched secret to retain its stored value. */
export const KEEP_SECRET = { $secret: { set: true } } as const;

export const isSecretNode = (node: JsonSchemaNode): boolean => node[SECRET_MARK] === true;

export function isKeepMarker(value: unknown): boolean {
	return (
		typeof value === 'object' &&
		value !== null &&
		'$secret' in value &&
		(value as { $secret?: { set?: unknown } }).$secret?.set === true
	);
}

export const unionBranches = (node: JsonSchemaNode): JsonSchemaNode[] | undefined =>
	node.oneOf ?? node.anyOf;

/** Finds the const-valued property that selects a union branch. */
export function branchDiscriminator(
	branch: JsonSchemaNode,
): { key: string; value: string } | undefined {
	for (const [key, prop] of Object.entries(branch.properties ?? {})) {
		if (typeof prop.const === 'string') return { key, value: prop.const };
	}
	return undefined;
}

/** Selects the union branch matching the current form value. */
export function branchForValue(node: JsonSchemaNode, value: unknown): JsonSchemaNode | undefined {
	const branches = unionBranches(node);
	if (!branches) return undefined;
	for (const branch of branches) {
		const d = branchDiscriminator(branch);
		if (d && (value as Record<string, unknown> | undefined)?.[d.key] === d.value) return branch;
	}
	return branches[0];
}

/** Whether a node is the key/value record shape supported by the form. */
export const isRecordNode = (node: JsonSchemaNode): boolean =>
	node.type === 'object' && !node.properties && typeof node.additionalProperties === 'object';

/** Builds a create-form value from schema defaults and first union branches. */
export function buildDefaults(node: JsonSchemaNode): unknown {
	if (node.default !== undefined) return structuredClone(node.default);
	const branches = unionBranches(node);
	if (branches) return buildDefaults(branches[0]);
	if (isSecretNode(node)) return '';
	switch (node.type) {
		case 'object': {
			if (isRecordNode(node)) return {};
			const out: Record<string, unknown> = {};
			for (const [key, child] of Object.entries(node.properties ?? {})) {
				if (typeof child.const === 'string') {
					out[key] = child.const;
				} else {
					out[key] = buildDefaults(child);
				}
			}
			return out;
		}
		case 'array':
			return [];
		case 'boolean':
			return false;
		case 'number':
		case 'integer':
			return undefined;
		case undefined:
		default:
			return node.enum ? (node.enum[0] ?? '') : '';
	}
}

const isRequired = (parent: JsonSchemaNode, key: string): boolean =>
	parent.required?.includes(key) ?? false;

/** Removes unset optional values so server-side defaults can apply. */
export function pruneForSubmit(node: JsonSchemaNode, value: unknown): unknown {
	const branch = branchForValue(node, value);
	if (branch) return pruneForSubmit(branch, value);
	if (node.type === 'object') {
		if (isRecordNode(node)) {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries((value as Record<string, unknown>) ?? {})) {
				if (k !== '') out[k] = v;
			}
			return out;
		}
		const record = (value as Record<string, unknown>) ?? {};
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(node.properties ?? {})) {
			const pruned = pruneForSubmit(child, record[key]);
			if (pruned === '' && !isRequired(node, key) && !isSecretNode(child)) continue;
			if (pruned === undefined) continue;
			out[key] = pruned;
		}
		return out;
	}
	if (node.type === 'array') {
		return ((value as unknown[]) ?? []).map((item) => pruneForSubmit(node.items ?? {}, item));
	}
	return value;
}

/** Performs lightweight form validation; the server schema remains authoritative. */
export function validateValue(
	node: JsonSchemaNode,
	value: unknown,
	path = '',
	required = true,
): Record<string, string> {
	const errors: Record<string, string> = {};
	const at = (p: string, message: string) => {
		errors[p] = message;
	};
	const branch = branchForValue(node, value);
	if (branch) return validateValue(branch, value, path, required);

	if (isSecretNode(node)) {
		if (required && value === '') at(path, 'Required');
		return errors;
	}
	switch (node.type) {
		case 'object': {
			if (isRecordNode(node)) {
				const pattern = node.propertyNames?.pattern;
				for (const key of Object.keys((value as Record<string, unknown>) ?? {})) {
					if (key !== '' && pattern && !new RegExp(pattern).test(key)) {
						at(`${path}${path ? '.' : ''}${key}`, `Invalid name "${key}"`);
					}
				}
				return errors;
			}
			const record = (value as Record<string, unknown>) ?? {};
			for (const [key, child] of Object.entries(node.properties ?? {})) {
				const childPath = path ? `${path}.${key}` : key;
				Object.assign(errors, validateValue(child, record[key], childPath, isRequired(node, key)));
			}
			return errors;
		}
		case 'array': {
			((value as unknown[]) ?? []).forEach((item, i) => {
				Object.assign(errors, validateValue(node.items ?? {}, item, `${path}[${i}]`, true));
			});
			return errors;
		}
		case 'number':
		case 'integer': {
			if (value === undefined || value === '') {
				if (required && node.default === undefined) at(path, 'Required');
				return errors;
			}
			const n = Number(value);
			if (Number.isNaN(n) || (node.type === 'integer' && !Number.isInteger(n))) {
				at(path, 'Must be a number');
			} else if (node.minimum !== undefined && n < node.minimum) {
				at(path, `Must be ≥ ${node.minimum}`);
			} else if (node.maximum !== undefined && n > node.maximum) {
				at(path, `Must be ≤ ${node.maximum}`);
			}
			return errors;
		}
		case undefined:
		default: {
			if (typeof value === 'string') {
				if (value === '') {
					if (required && node.default === undefined && !node.enum) at(path, 'Required');
				} else if (node.pattern && !new RegExp(node.pattern).test(value)) {
					at(path, 'Invalid format');
				}
			}
			return errors;
		}
	}
}

/** Hint lookup: concrete paths (`secrets[2].value`) match wildcard keys (`secrets.*.value`). */
export function hintFor(hints: UiHints, path: string): FieldHint | undefined {
	return hints[path] ?? hints[path.replaceAll(/\[\d+\]/g, '.*')];
}

export interface FieldGroup {
	/** Empty for the untitled leading group. */
	title: string;
	advanced: boolean;
	fields: { key: string; node: JsonSchemaNode }[];
}

/** Orders top-level fields and groups them by layout hints. */
export function groupFields(schema: JsonSchemaNode, hints: UiHints): FieldGroup[] {
	const entries = Object.entries(schema.properties ?? {}).map(([key, node], index) => ({
		key,
		node,
		order: hintFor(hints, key)?.order ?? index,
		group: hintFor(hints, key)?.group ?? '',
		advanced: hintFor(hints, key)?.advanced ?? false,
	}));
	entries.sort((a, b) => a.order - b.order);
	const groups: FieldGroup[] = [];
	for (const entry of entries) {
		const last = groups.at(-1);
		const target =
			last && last.title === entry.group && last.advanced === entry.advanced
				? last
				: (groups.push({ title: entry.group, advanced: entry.advanced, fields: [] }),
					groups.at(-1) as FieldGroup);
		target.fields.push({ key: entry.key, node: entry.node });
	}
	// Advanced groups render last without disturbing order within either partition.
	return [...groups.filter((g) => !g.advanced), ...groups.filter((g) => g.advanced)];
}
