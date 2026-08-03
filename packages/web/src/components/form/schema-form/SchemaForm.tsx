import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronRight, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { TextField as AriaTextField, FieldError, Label, TextArea } from 'react-aria-components';
import { Button, IconButton, TextField } from '@/components/ui';
import { cn } from '@/lib/utils';
import {
	branchDiscriminator,
	branchForValue,
	buildDefaults,
	groupFields,
	hintFor,
	isKeepMarker,
	isRecordNode,
	isSecretNode,
	KEEP_SECRET,
	needsSecretSource,
	referenceSecret,
	unionBranches,
} from './model';
import type { FieldHint, JsonSchemaNode, SecretSources, UiHints } from './model';

// Stable ids for editable rows (kv pairs, list items): keying by index would
// remount inputs on removal and lose focus; keying by content remounts per
// keystroke. Rows live in field-local state with a synthetic id and sync out.
let nextRowId = 0;
const rowId = () => ++nextRowId;

export interface SchemaFormProps {
	schema: JsonSchemaNode;
	hints: UiHints;
	value: Record<string, unknown>;
	onChange: (next: Record<string, unknown>) => void;
	/** Validation messages keyed by concrete field path. */
	errors?: Record<string, string>;
	/** Whether secret keep-markers should expose the Replace control. */
	editing?: boolean;
	secretSources?: SecretSources;
}

/** Controlled form for the integration JSON Schema dialect. */
export function SchemaForm({
	schema,
	hints,
	value,
	onChange,
	errors,
	editing,
	secretSources = { inline: true, references: [] },
}: SchemaFormProps) {
	const groups = groupFields(schema, hints);
	const hasUnavailableSecrets =
		needsSecretSource(schema, value) &&
		!secretSources.inline &&
		secretSources.references.length === 0;
	const setField = (key: string, next: unknown) => onChange({ ...value, [key]: next });
	return (
		<div className="flex flex-col gap-4">
			{hasUnavailableSecrets && (
				<p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
					This integration requires protected values, but this deployment has no integration secret
					source. Ask an administrator to configure inline encryption or an external secret backend.
				</p>
			)}
			{groups.map((group) => (
				// Groups partition the fields, so the first field key is unique.
				<GroupSection key={group.fields[0].key} title={group.title} advanced={group.advanced}>
					{group.fields.map(({ key, node }) => (
						<SchemaField
							key={key}
							path={key}
							node={node}
							hints={hints}
							value={value[key]}
							onChange={(next) => setField(key, next)}
							errors={errors}
							editing={editing}
							secretSources={secretSources}
						/>
					))}
				</GroupSection>
			))}
		</div>
	);
}

function GroupSection({
	title,
	advanced,
	children,
}: {
	title: string;
	advanced: boolean;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(!advanced);
	if (!advanced) {
		return (
			<section className="flex flex-col gap-3">
				{title && <h4 className="text-xs font-semibold text-muted-foreground">{title}</h4>}
				{children}
			</section>
		);
	}
	return (
		<section className="flex flex-col gap-2 border-t pt-3">
			<button
				type="button"
				className="flex items-center gap-1 text-left text-xs font-semibold text-muted-foreground hover:text-foreground"
				onClick={() => setOpen((o) => !o)}
			>
				<ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
				{title || 'Advanced'}
			</button>
			{open && <div className="flex flex-col gap-3">{children}</div>}
		</section>
	);
}

interface SchemaFieldProps {
	path: string;
	node: JsonSchemaNode;
	hints: UiHints;
	value: unknown;
	onChange: (next: unknown) => void;
	errors?: Record<string, string>;
	editing?: boolean;
	secretSources: SecretSources;
}

function SchemaField(props: SchemaFieldProps) {
	const { path, node, hints, value, onChange, errors } = props;
	const hint = hintFor(hints, path);
	const error = errors?.[path];
	const label = humanize(path.split(/\.|\[/).at(-1) ?? path);

	if (unionBranches(node)) return <UnionField {...props} label={label} />;
	if (isSecretNode(node)) return <SecretField {...props} hint={hint} error={error} label={label} />;
	if (isRecordNode(node)) return <KvPairsField {...props} error={error} label={label} />;

	switch (node.type) {
		case 'object':
			return <NestedObjectField {...props} label={label} />;
		case 'array':
			return <ObjectListField {...props} label={label} />;
		case 'boolean':
			return (
				<Toggle
					label={label}
					description={node.description}
					isSelected={Boolean(value)}
					onChange={onChange}
				/>
			);
		case 'number':
		case 'integer':
			return (
				<FieldShell description={node.description}>
					<TextField
						label={label}
						placeholder={placeholderFor(node, hint)}
						value={typeof value === 'number' || typeof value === 'string' ? String(value) : ''}
						onChange={(text) => onChange(text === '' ? undefined : coerceNumber(text))}
						error={error}
						inputMode="decimal"
					/>
				</FieldShell>
			);
		case undefined:
		default:
			if (node.enum) {
				return (
					<Segmented
						label={label}
						description={node.description}
						options={node.enum.map(String)}
						value={typeof value === 'string' ? value : ''}
						onChange={onChange}
					/>
				);
			}
			if (hint?.widget === 'textarea') {
				return (
					<FieldShell description={node.description}>
						<TextAreaField
							label={label}
							placeholder={placeholderFor(node, hint)}
							value={typeof value === 'string' ? value : ''}
							onChange={onChange}
							error={error}
						/>
					</FieldShell>
				);
			}
			return (
				<FieldShell description={node.description}>
					<TextField
						label={label}
						placeholder={placeholderFor(node, hint)}
						value={typeof value === 'string' ? value : ''}
						onChange={onChange}
						error={error}
					/>
				</FieldShell>
			);
	}
}

/**
 * Multi-line counterpart of `TextField` for `widget: 'textarea'` hints: PEM
 * bundles and `krb5.conf` contents lose their newlines in a single-line input.
 */
function TextAreaField({
	label,
	placeholder,
	value,
	onChange,
	error,
}: {
	label: string;
	placeholder?: string;
	value: string;
	onChange: (next: string) => void;
	error?: string;
}) {
	return (
		<AriaTextField
			className="flex flex-col gap-1.5"
			isInvalid={!!error}
			value={value}
			onChange={onChange}
		>
			<Label className="text-xs font-medium text-muted-foreground">{label}</Label>
			<TextArea
				placeholder={placeholder}
				rows={4}
				className={cn(
					'w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground shadow-sm transition-colors',
					'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
					'data-[invalid]:border-destructive data-[invalid]:focus-visible:ring-destructive',
				)}
			/>
			{error && <FieldError className="text-xs text-destructive">{error}</FieldError>}
		</AriaTextField>
	);
}

function UnionField(props: SchemaFieldProps & { label: string }) {
	const { path, node, hints, value, onChange, errors, editing, secretSources, label } = props;
	const branches = unionBranches(node) ?? [];
	const active = branchForValue(node, value) ?? branches[0];
	const discriminator = branchDiscriminator(active);
	const record = (value as Record<string, unknown>) ?? {};

	return (
		<div className="flex flex-col gap-2">
			<Segmented
				label={label}
				description={node.description}
				options={branches.map((b) => branchDiscriminator(b)?.value ?? '?')}
				value={
					discriminator
						? typeof record[discriminator.key] === 'string'
							? (record[discriminator.key] as string)
							: discriminator.value
						: ''
				}
				onChange={(selected) => {
					const branch = branches.find((b) => branchDiscriminator(b)?.value === selected);
					// Switching branches resets to that branch's defaults — stale fields
					// from the previous branch must not linger in the submitted config.
					if (branch) onChange(buildDefaults(branch));
				}}
			/>
			<div className="flex flex-col gap-3 border-l-2 border-input pl-3 empty:hidden">
				{Object.entries(active.properties ?? {})
					.filter(([key]) => key !== discriminator?.key)
					.map(([key, child]) => (
						<SchemaField
							key={key}
							path={`${path}.${key}`}
							node={child}
							hints={hints}
							value={record[key]}
							onChange={(next) => onChange({ ...record, [key]: next })}
							errors={errors}
							editing={editing}
							secretSources={secretSources}
						/>
					))}
			</div>
		</div>
	);
}

function NestedObjectField(props: SchemaFieldProps & { label: string }) {
	const { path, node, hints, value, onChange, errors, editing, secretSources, label } = props;
	const record = (value as Record<string, unknown>) ?? {};
	return (
		<div className="flex flex-col gap-2">
			<span className="text-xs font-medium text-muted-foreground">{label}</span>
			<div className="flex flex-col gap-3 border-l-2 border-input pl-3">
				{Object.entries(node.properties ?? {}).map(([key, child]) => (
					<SchemaField
						key={key}
						path={`${path}.${key}`}
						node={child}
						hints={hints}
						value={record[key]}
						onChange={(next) => onChange({ ...record, [key]: next })}
						errors={errors}
						editing={editing}
						secretSources={secretSources}
					/>
				))}
			</div>
		</div>
	);
}

function SecretField({
	node,
	value,
	onChange,
	hint,
	error,
	editing,
	secretSources,
	label,
}: SchemaFieldProps & { hint?: FieldHint; error?: string; label: string }) {
	const reference = referenceSecret(value);
	const initialManaged = useRef(isKeepMarker(value));
	const lastInline = useRef<unknown>(isKeepMarker(value) || typeof value === 'string' ? value : '');
	const lastReference = useRef(reference);
	if (reference) lastReference.current = reference;
	else if (isKeepMarker(value) || typeof value === 'string') lastInline.current = value;
	const options = [
		...(secretSources.inline ? ['inline'] : []),
		...(secretSources.references.length > 0 ? ['reference'] : []),
	];
	if (options.length === 0) {
		return (
			<div className="flex items-center justify-between rounded-md border border-input bg-muted/30 px-3 py-2">
				<span className="text-xs font-medium text-muted-foreground">{label}</span>
				<span className="text-xs text-muted-foreground">Unavailable</span>
			</div>
		);
	}
	const usesReference =
		secretSources.references.length > 0 && (reference !== undefined || !secretSources.inline);
	const selected = usesReference ? 'reference' : 'inline';
	const externalValue =
		reference ??
		lastReference.current ??
		({
			$secret: {
				kind: 'reference',
				backend: secretSources.references[0]?.backend ?? '',
				locator: '',
			},
		} as const);
	const choose = (source: string) => {
		if (source === 'inline') onChange(lastInline.current);
		else onChange(externalValue);
	};

	const sourceSelector = options.length > 1 && (
		<Segmented
			label="Source"
			options={options}
			optionLabels={{ inline: 'Encrypted value', reference: 'External secret' }}
			value={selected}
			onChange={choose}
		/>
	);

	if (isKeepMarker(value) && selected === 'inline') {
		return (
			<div className="flex flex-col gap-2">
				{sourceSelector}
				<span className="text-xs font-medium text-muted-foreground">{label}</span>
				<div className="flex h-9 items-center justify-between rounded-md border border-input bg-muted/40 px-3">
					<span className="text-sm tracking-widest text-muted-foreground">•••••••• (set)</span>
					<Button variant="ghost" size="sm" onPress={() => onChange('')}>
						Replace
					</Button>
				</div>
			</div>
		);
	}
	if (selected === 'reference') {
		const selectedSource = secretSources.references.find(
			(source) => source.backend === externalValue.$secret.backend,
		);
		const backendAvailable = selectedSource !== undefined;
		return (
			<div className="flex flex-col gap-2">
				<span className="text-xs font-medium text-muted-foreground">{label}</span>
				{sourceSelector}
				<label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
					Secret manager
					<select
						className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
						value={backendAvailable ? externalValue.$secret.backend : ''}
						onChange={(event) =>
							onChange({
								$secret: { ...externalValue.$secret, backend: event.target.value },
							})
						}
					>
						{!backendAvailable && (
							<option value="" disabled>
								Unavailable backend: {externalValue.$secret.backend}
							</option>
						)}
						{secretSources.references.map((source) => (
							<option key={source.backend} value={source.backend}>
								{source.title}
							</option>
						))}
					</select>
				</label>
				<TextField
					label="Secret locator"
					placeholder={selectedSource?.locator_placeholder}
					value={externalValue.$secret.locator}
					onChange={(locator) => onChange({ $secret: { ...externalValue.$secret, locator } })}
					error={error}
				/>
				{selectedSource && (
					<p className="text-xs text-muted-foreground">
						{selectedSource.locator_help}{' '}
						{selectedSource.docs_url && (
							<a
								href={selectedSource.docs_url}
								target="_blank"
								rel="noreferrer"
								className="font-medium text-primary hover:underline"
							>
								Learn more
							</a>
						)}
					</p>
				)}
				{node.description && <p className="text-xs text-muted-foreground">{node.description}</p>}
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-2">
			{sourceSelector}
			<FieldShell description={node.description}>
				<div className="flex items-end gap-1.5">
					<div className="min-w-0 flex-1">
						<TextField
							label={label}
							type="password"
							autoComplete="new-password"
							placeholder={hint?.placeholder}
							value={typeof value === 'string' ? value : ''}
							onChange={onChange}
							error={error}
						/>
					</div>
					{editing && initialManaged.current && !isKeepMarker(value) && (
						<IconButton
							label="Restore stored encrypted value"
							tooltip="Restore stored encrypted value"
							onPress={() => onChange(structuredClone(KEEP_SECRET))}
						>
							<RotateCcw className="size-4" />
						</IconButton>
					)}
				</div>
			</FieldShell>
		</div>
	);
}

function KvPairsField({
	node,
	value,
	onChange,
	error,
	label,
}: SchemaFieldProps & { error?: string; label: string }) {
	const [rows, setRows] = useState<{ id: number; k: string; v: string }[]>(() =>
		Object.entries((value as Record<string, string>) ?? {}).map(([k, v]) => ({
			id: rowId(),
			k,
			v,
		})),
	);
	const commit = (next: { id: number; k: string; v: string }[]) => {
		setRows(next);
		onChange(Object.fromEntries(next.map((r) => [r.k, r.v])));
	};
	// `Object.fromEntries` silently keeps only the LAST value per key, so rows
	// that would collapse must be called out before the user submits.
	const duplicateKeys = [
		...new Set(rows.map((r) => r.k).filter((k, i, all) => k !== '' && all.indexOf(k) !== i)),
	];
	const hasBlankKey = rows.some((r) => r.k === '' && r.v !== '');
	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-xs font-medium text-muted-foreground">{label}</span>
			{node.description && <p className="text-xs text-muted-foreground">{node.description}</p>}
			{rows.map((row) => (
				<div key={row.id} className="flex items-center gap-1.5">
					<div className="w-2/5">
						<TextField
							aria-label={`${label} name`}
							placeholder="NAME"
							value={row.k}
							onChange={(k) => commit(rows.map((r) => (r.id === row.id ? { ...r, k } : r)))}
						/>
					</div>
					<div className="min-w-0 flex-1">
						<TextField
							aria-label={`${label} value`}
							placeholder="value"
							value={row.v}
							onChange={(v) => commit(rows.map((r) => (r.id === row.id ? { ...r, v } : r)))}
						/>
					</div>
					<IconButton
						label="Remove"
						tooltip="Remove"
						tone="danger"
						onPress={() => commit(rows.filter((r) => r.id !== row.id))}
					>
						<Trash2 className="size-4" />
					</IconButton>
				</div>
			))}
			{duplicateKeys.length > 0 && (
				<p className="text-xs text-destructive">
					Duplicate name{duplicateKeys.length > 1 ? 's' : ''}: {duplicateKeys.join(', ')} — only the
					last value will be saved.
				</p>
			)}
			{hasBlankKey && <p className="text-xs text-destructive">A value is missing its name.</p>}
			{error && <p className="text-xs text-destructive">{error}</p>}
			<div>
				<Button
					variant="ghost"
					size="sm"
					onPress={() => commit([...rows, { id: rowId(), k: '', v: '' }])}
				>
					<Plus className="size-4" />
					Add
				</Button>
			</div>
		</div>
	);
}

/** Renders a schema array whose items are uniform objects. */
function ObjectListField(props: SchemaFieldProps & { label: string }) {
	const { path, node, hints, value, onChange, errors, editing, secretSources, label } = props;
	const itemSchema = node.items ?? {};
	const [rows, setRows] = useState<{ id: number; item: Record<string, unknown> }[]>(() =>
		((value as Record<string, unknown>[]) ?? []).map((item) => ({ id: rowId(), item })),
	);
	const commit = (next: { id: number; item: Record<string, unknown> }[]) => {
		setRows(next);
		onChange(next.map((r) => r.item));
	};
	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-xs font-medium text-muted-foreground">{label}</span>
			{node.description && <p className="text-xs text-muted-foreground">{node.description}</p>}
			{rows.map((row, i) => (
				<div key={row.id} className="flex items-end gap-1.5">
					{Object.entries(itemSchema.properties ?? {}).map(([key, child]) => (
						<div key={key} className={cn('min-w-0', key === 'name' ? 'w-2/5' : 'flex-1')}>
							<SchemaField
								path={`${path}[${i}].${key}`}
								node={child}
								hints={hints}
								value={row.item[key]}
								onChange={(next) =>
									commit(
										rows.map((r) =>
											r.id === row.id ? { ...r, item: { ...r.item, [key]: next } } : r,
										),
									)
								}
								errors={errors}
								editing={editing}
								secretSources={secretSources}
							/>
						</div>
					))}
					<IconButton
						label="Remove"
						tooltip="Remove"
						tone="danger"
						onPress={() => commit(rows.filter((r) => r.id !== row.id))}
					>
						<Trash2 className="size-4" />
					</IconButton>
				</div>
			))}
			<div>
				<Button
					variant="ghost"
					size="sm"
					onPress={() =>
						commit([
							...rows,
							{ id: rowId(), item: buildDefaults(itemSchema) as Record<string, unknown> },
						])
					}
				>
					<Plus className="size-4" />
					Add
				</Button>
			</div>
		</div>
	);
}

function Segmented({
	label,
	description,
	options,
	value,
	onChange,
	optionLabels,
}: {
	label: string;
	description?: string;
	options: string[];
	value: string;
	onChange: (next: string) => void;
	optionLabels?: Record<string, string>;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-xs font-medium text-muted-foreground">{label}</span>
			<div className="flex w-fit flex-wrap gap-0.5 rounded-md border border-input bg-muted/40 p-0.5">
				{options.map((option) => (
					<button
						key={option}
						type="button"
						onClick={() => onChange(option)}
						className={cn(
							'rounded px-2.5 py-1 text-xs font-medium transition-colors',
							option === value
								? 'bg-background text-foreground shadow-sm'
								: 'text-muted-foreground hover:text-foreground',
						)}
					>
						{optionLabels?.[option] ?? humanize(option)}
					</button>
				))}
			</div>
			{description && <p className="text-xs text-muted-foreground">{description}</p>}
		</div>
	);
}

function Toggle({
	label,
	description,
	isSelected,
	onChange,
}: {
	label: string;
	description?: string;
	isSelected: boolean;
	onChange: (next: boolean) => void;
}) {
	return (
		<div className="flex items-center gap-3">
			<button
				type="button"
				role="switch"
				aria-checked={isSelected}
				aria-label={label}
				onClick={() => onChange(!isSelected)}
				className={cn(
					'relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors',
					isSelected ? 'bg-primary' : 'bg-input',
				)}
			>
				<span
					className={cn(
						'absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-sm transition-transform',
						isSelected && 'translate-x-4',
					)}
				/>
			</button>
			<span className="flex flex-col">
				<span className="text-sm font-medium">{label}</span>
				{description && <span className="text-xs text-muted-foreground">{description}</span>}
			</span>
		</div>
	);
}

function FieldShell({ description, children }: { description?: string; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-1">
			{children}
			{description && <p className="text-xs text-muted-foreground">{description}</p>}
		</div>
	);
}

function placeholderFor(node: JsonSchemaNode, hint: FieldHint | undefined): string | undefined {
	if (hint?.placeholder) return hint.placeholder;
	const fallback = node.default;
	return typeof fallback === 'string' ||
		typeof fallback === 'number' ||
		typeof fallback === 'boolean'
		? String(fallback)
		: undefined;
}

function coerceNumber(text: string): unknown {
	const n = Number(text);
	// Mid-typing states ("1.", "-") stay strings; validation flags them on submit.
	return Number.isNaN(n) || text.endsWith('.') || text === '-' ? text : n;
}

function humanize(key: string): string {
	const words = key.replaceAll('_', ' ').replaceAll(']', '').trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}
