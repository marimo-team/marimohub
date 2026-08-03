import * as simpleIcons from 'simple-icons';

/**
 * Renders one body-only markdown partial per integration kind from the
 * committed `internal/schemas/integrations.yml`. The partials are included
 * into `docs/integrations.md` and drift-guarded by `generate.test.ts`, so the
 * config reference cannot go stale against the zod schemas.
 */

interface JsonSchema {
	type?: string;
	const?: unknown;
	enum?: unknown[];
	default?: unknown;
	description?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	oneOf?: JsonSchema[];
	additionalProperties?: JsonSchema;
	propertyNames?: JsonSchema;
	'x-marimohub-secret'?: boolean;
}

interface KindPathItem {
	summary: string;
	description: string;
	'x-kind-schema-version': number;
	'x-category': string;
	'x-brand-color': string;
	'x-brand-icon'?: string;
	'x-supports-test': boolean;
	'x-requirements': string[];
}

export interface IntegrationsSpec {
	paths: Record<string, KindPathItem>;
	components: { schemas: Record<string, JsonSchema> };
}

export interface SimpleIcon {
	slug: string;
	title: string;
	hex: string;
	path: string;
}

export const iconsBySlug: ReadonlyMap<string, SimpleIcon> = new Map(
	Object.values(simpleIcons as Record<string, SimpleIcon>)
		.filter((icon) => typeof icon === 'object' && icon !== null && 'slug' in icon)
		.map((icon) => [icon.slug, icon]),
);

export function kindsOf(spec: IntegrationsSpec): Map<string, KindPathItem> {
	const kinds = new Map<string, KindPathItem>();
	for (const [route, item] of Object.entries(spec.paths)) {
		const kind = /^\/kinds\/([^/]+)\/config$/.exec(route)?.[1];
		if (kind) kinds.set(kind, item);
	}
	return kinds;
}

export function renderIntegrationPartials(spec: IntegrationsSpec): Map<string, string> {
	const partials = new Map<string, string>();
	for (const [kind, item] of [...kindsOf(spec)].sort(([a], [b]) => a.localeCompare(b))) {
		const schema = spec.components.schemas[kind];
		if (!schema) throw new Error(`no component schema for kind ${kind}`);
		partials.set(kind, renderPartial(kind, item, schema));
	}
	return partials;
}

function renderPartial(kind: string, item: KindPathItem, schema: JsonSchema): string {
	const lines: string[] = [
		'<!-- GENERATED from internal/schemas/integrations.yml — do not edit; run `pnpm schemas:generate`. -->',
		'',
		metaLine(kind, item),
	];

	if (item['x-requirements'].length > 0) {
		lines.push('', `**Notebook packages:** ${item['x-requirements'].map(code).join(', ')}`);
	}

	// Collapsed: ten kinds' tables on one page would swamp the prose.
	lines.push('', `::: details ${item.summary} configuration reference`);
	if (hasSecret(schema)) {
		lines.push('', 'Fields marked 🔒 are secret: encrypted at rest and write-only after save.');
	}
	lines.push('', renderObject(schema, '').trimEnd(), '', ':::');
	return `${lines
		.join('\n')
		.replaceAll(/\n{3,}/g, '\n\n')
		.trimEnd()}\n`;
}

function metaLine(kind: string, item: KindPathItem): string {
	const color = item['x-brand-color'];
	const slug = item['x-brand-icon'];
	let chip: string;
	if (slug) {
		const icon = iconsBySlug.get(slug);
		if (!icon) throw new Error(`kind ${kind}: unknown simple-icons slug ${slug}`);
		chip =
			`<span style="display:inline-block;padding:3px;border-radius:6px;background:var(--vp-c-default-soft);vertical-align:-7px">` +
			`<svg role="img" aria-label="${icon.title} logo" viewBox="0 0 24 24" width="18" height="18" fill="${color}"><path d="${icon.path}"/></svg>` +
			`</span>`;
	} else {
		chip = `<span style="display:inline-block;width:12px;height:12px;border-radius:9999px;background:${color};vertical-align:-1px"></span>`;
	}
	const parts = [
		chip,
		code(kind),
		item['x-category'],
		`config schema v${item['x-kind-schema-version']}`,
	];
	if (item['x-supports-test']) parts.push('connection test supported');
	return `${parts[0]} ${parts.slice(1).join(' · ')}`;
}

/** Renders an object schema as a field table plus per-union-branch sub-blocks. */
function renderObject(schema: JsonSchema, base: string): string {
	const rows: string[] = [];
	const blocks: string[] = [];
	collectRows(schema, base, rows, blocks);
	const table = [
		'| Field | Type | Required | Default | Description |',
		'| --- | --- | --- | --- | --- |',
		...rows,
	].join('\n');
	return [table, ...blocks].join('\n\n');
}

function collectRows(schema: JsonSchema, base: string, rows: string[], blocks: string[]): void {
	const required = new Set(schema.required ?? []);
	for (const [name, prop] of Object.entries(schema.properties ?? {})) {
		const path = base === '' ? name : `${base}.${name}`;
		const union = discriminatedUnion(prop);
		if (union) {
			// Comma separators: the llms md twins unescape `\|`, which would break the table.
			const values = union.branches.map(([value]) => code(literal(value))).join(', ');
			const fallback = (prop.default as Record<string, unknown> | undefined)?.[union.key];
			rows.push(
				row(`${path}.${union.key}`, values, required.has(name), fallback, prop.description, false),
			);
			for (const [value, branch] of union.branches) {
				const props = Object.keys(branch.properties ?? {}).filter((key) => key !== union.key);
				if (props.length === 0) continue;
				const { [union.key]: _, ...rest } = branch.properties ?? {};
				blocks.push(
					`**${code(`${path}.${union.key}: ${literal(value)}`)}**\n\n${renderObject(
						{ ...branch, properties: rest },
						path,
					)}`,
				);
			}
		} else if (isMap(prop)) {
			const valueType = prop.additionalProperties?.type ?? 'string';
			rows.push(
				row(
					path,
					`map&lt;string, ${valueType}&gt;`,
					required.has(name),
					undefined,
					prop.description,
					false,
				),
			);
		} else if (prop.type === 'object' && prop.properties) {
			collectRows(prop, path, rows, blocks);
		} else if (prop.type === 'array' && prop.items?.type === 'object' && prop.items.properties) {
			if (prop.description) {
				rows.push(row(path, 'object[]', required.has(name), undefined, prop.description, false));
			}
			collectRows(prop.items, `${path}[]`, rows, blocks);
		} else {
			rows.push(
				row(
					path,
					typeLabel(prop),
					required.has(name),
					prop.default,
					prop.description,
					prop['x-marimohub-secret'] === true,
				),
			);
		}
	}
}

function row(
	path: string,
	type: string,
	required: boolean,
	fallback: unknown,
	description: string | undefined,
	secret: boolean,
): string {
	const field = secret ? `${code(path)} 🔒` : code(path);
	const cells = [
		field,
		type,
		required ? 'Yes' : '',
		primitiveDefault(fallback),
		cell(description ?? ''),
	];
	return `| ${cells.join(' | ')} |`;
}

/** Discriminated union: every branch is an object sharing one `const` key. */
function discriminatedUnion(
	prop: JsonSchema,
): { key: string; branches: [unknown, JsonSchema][] } | undefined {
	const branches = prop.oneOf;
	if (!branches || branches.some((b) => b.type !== 'object' || !b.properties)) return undefined;
	const [first, ...others] = branches;
	for (const [key, keySchema] of Object.entries(first?.properties ?? {})) {
		if (keySchema.const === undefined) continue;
		if (others.every((b) => b.properties?.[key]?.const !== undefined)) {
			return { key, branches: branches.map((b) => [b.properties?.[key]?.const, b]) };
		}
	}
	return undefined;
}

function isMap(prop: JsonSchema): boolean {
	return (
		prop.type === 'object' &&
		prop.properties === undefined &&
		prop.additionalProperties !== undefined
	);
}

function typeLabel(prop: JsonSchema): string {
	if (prop.const !== undefined) return code(literal(prop.const));
	if (prop.enum) return prop.enum.map((value) => code(literal(value))).join(', ');
	if (prop.type === 'array') return `${prop.items ? typeLabel(prop.items) : 'unknown'}[]`;
	return prop.type ?? '';
}

function primitiveDefault(value: unknown): string {
	if (value === undefined || value === null) return '';
	if (typeof value === 'object') return '';
	return code(literal(value));
}

/** Schema literals are JSON values; strings render bare, the rest as JSON. */
function literal(value: unknown): string {
	return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
}

function hasSecret(schema: JsonSchema): boolean {
	if (schema['x-marimohub-secret'] === true) return true;
	const children = [
		...Object.values(schema.properties ?? {}),
		...(schema.oneOf ?? []),
		...(schema.items ? [schema.items] : []),
	];
	return children.some(hasSecret);
}

function code(text: string): string {
	return `\`${text}\``;
}

/** Escapes table-breaking pipes; descriptions may carry inline code already. */
function cell(text: string): string {
	return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}
