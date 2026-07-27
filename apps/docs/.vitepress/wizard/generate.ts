/**
 * `selection -> code` generators (no Vue/DOM imports). Driven by the wizard
 * spec, which derives from `CONFIG_SPEC`, so new backends/options flow through.
 */
import {
	ALL_VARS_BY_ID,
	AUTH_WIRING,
	backendFor,
	COMPUTE_WIRING,
	EXTRA_OPTIONS,
	SERVER_EXTRA_VARS,
	SHARED_COMPUTE_VARS,
	STORAGE_WIRING,
} from './spec';
import type { ConfigVar } from './spec';

export interface WizardSelection {
	storage: string;
	compute: string;
	auth: string;
	/** Managed-AI backend: `none` (default) or `openai-compatible`. */
	ai: string;
	/** Extra option id -> value (e.g. persist workspace, sandbox image). */
	options?: Record<string, string>;
	/** Per-var overrides keyed by env id; take precedence over options + defaults. */
	values?: Record<string, string>;
}

/** A documented default that is a concrete value (not prose like `auto (SDK default)`). */
function concreteDefault(d?: string): string {
	if (!d) return '';
	if (d.includes(' ') || d.includes('(')) return '';
	return d;
}

/**
 * Effective values: each extra option's sane default, then the user's option
 * picks, then explicit per-var overrides (later wins). Seeding option defaults
 * ensures e.g. persist-workspace shows `source` rather than the var's `example`.
 */
function effective(sel: WizardSelection): Record<string, string> {
	const optionDefaults = Object.fromEntries(EXTRA_OPTIONS.map((o) => [o.id, o.default]));
	return { ...optionDefaults, ...sel.options, ...sel.values };
}

/** Resolve a var's value: explicit override -> example -> concrete default -> unset. */
export function resolveValue(id: string, values: Record<string, string>): string {
	const user = values[id]?.trim();
	if (user) return user;
	const v = ALL_VARS_BY_ID.get(id);
	if (v?.example) return v.example;
	return concreteDefault(v?.default);
}

interface GeneratedValue {
	value: string;
	example?: string;
}

function generatedValue(
	v: ConfigVar,
	values: Record<string, string>,
	sel: WizardSelection,
): GeneratedValue {
	const explicit = values[v.id]?.trim();
	if (explicit) return { value: explicit };
	if (v.id === 'MARIMOHUB_ALLOW_EPHEMERAL_STORAGE' && sel.storage === 'memory') {
		return { value: 'true' };
	}

	const requiredForSelection =
		v.required || (v.id === 'MARIMOHUB_COMPUTE_IMAGE' && sel.compute === 'modal');
	if (requiredForSelection) return { value: '_replace_me_', example: v.example };
	return { value: resolveValue(v.id, values) };
}

interface Section {
	title: string;
	selector?: { id: string; value: string };
	vars: ConfigVar[];
}

/** The ordered config sections for a selection (storage, compute, auth, options). */
function sections(sel: WizardSelection): Section[] {
	const storage = backendFor('storage', sel.storage);
	const compute = backendFor('compute', sel.compute);
	const auth = backendFor('auth', sel.auth);
	const ai = backendFor('ai', sel.ai);
	return [
		{
			title: 'Storage',
			selector: { id: 'MARIMOHUB_STORAGE_BACKEND', value: sel.storage },
			vars: storage?.vars ?? [],
		},
		{
			title: 'Compute',
			selector: { id: 'MARIMOHUB_COMPUTE_BACKEND', value: sel.compute },
			vars: [...SHARED_COMPUTE_VARS, ...(compute?.vars ?? [])],
		},
		{
			title: 'Auth',
			selector: { id: 'MARIMOHUB_AUTH_BACKEND', value: sel.auth },
			vars: auth?.vars ?? [],
		},
		{
			title: 'Managed AI',
			selector: { id: 'MARIMOHUB_AI_BACKEND', value: sel.ai },
			vars: ai?.vars ?? [],
		},
		{ title: 'Options', vars: SERVER_EXTRA_VARS },
	].filter((s) => s.selector || s.vars.length > 0);
}

// --- CONFIGS: .env ---

export function generateEnv(sel: WizardSelection): string {
	const values = effective(sel);
	const blocks = sections(sel).map((section) => {
		const lines: string[] = [`# --- ${section.title} ---`];
		if (section.selector) {
			lines.push(`${section.selector.id}=${section.selector.value}`);
		}
		for (const v of section.vars) {
			const generated = generatedValue(v, values, sel);
			const notes = [v.required ? 'required' : '', v.secret ? 'secret' : '']
				.filter(Boolean)
				.join(', ');
			const hint = generated.example
				? `  # e.g. ${generated.example}`
				: (generated.value === '_replace_me_' || !generated.value) && notes
					? `  # ${notes}`
					: '';
			lines.push(`${v.id}=${generated.value}${hint}`);
		}
		return lines.join('\n');
	});
	return blocks.join('\n\n');
}

// --- CONFIGS: Helm values.yaml ---

const SAFE_YAML = /^[A-Za-z0-9_./:{}-]+$/;

function yamlScalar(value: string): string {
	return value && SAFE_YAML.test(value) ? value : JSON.stringify(value);
}

export function generateHelm(sel: WizardSelection): string {
	const values = effective(sel);
	const config: string[] = [];
	const secrets: string[] = [];
	for (const section of sections(sel)) {
		if (section.selector) {
			config.push(`  ${section.selector.id}: ${yamlScalar(section.selector.value)}`);
		}
		for (const v of section.vars) {
			const generated = generatedValue(v, values, sel);
			const rendered = `${yamlScalar(generated.value)}${
				generated.example ? ` # e.g. ${generated.example}` : ''
			}`;
			if (v.secret) {
				secrets.push(`    ${v.id}: ${rendered}`);
			} else {
				config.push(`  ${v.id}: ${rendered}`);
			}
		}
	}
	const out = ['# Non-secret MARIMOHUB_* config -> ConfigMap.', 'config:', ...config];
	out.push(
		'',
		'# Secret values -> Secret (prefer secrets.existingSecret in production).',
		'secrets:',
		'  data:',
	);
	out.push(...(secrets.length > 0 ? secrets : ['    {}']));
	return out.join('\n');
}

// --- CONFIGS: docker-compose ---

const COMPOSE_IMAGE = 'ghcr.io/marimo-team/marimohub:latest';

export function generateCompose(sel: WizardSelection): string {
	const values = effective(sel);
	const env: string[] = [];
	for (const section of sections(sel)) {
		if (section.selector) {
			env.push(`      ${section.selector.id}: ${yamlScalar(section.selector.value)}`);
		}
		for (const v of section.vars) {
			const generated = generatedValue(v, values, sel);
			env.push(
				`      ${v.id}: ${yamlScalar(generated.value)}${
					generated.example ? ` # e.g. ${generated.example}` : ''
				}`,
			);
		}
	}
	return [
		'services:',
		'  marimohub:',
		`    image: ${COMPOSE_IMAGE}`,
		'    ports:',
		"      - '3000:3000'",
		'    environment:',
		...env,
	].join('\n');
}

// --- Selection validation (mirrors the fail-closed guards in packages/config/src/index.ts) ---

export type WarningLevel = 'info' | 'warning' | 'danger';

export interface SelectionWarning {
	level: WarningLevel;
	title: string;
	message: string;
}

/** Pre-flight warnings for risky backend choices. */
export function validateSelection(sel: WizardSelection): SelectionWarning[] {
	const warnings: SelectionWarning[] = [];
	if (sel.auth === 'dev') {
		warnings.push({
			level: 'danger',
			title: 'Dev auth is not a real login',
			message: 'The dev backend signs everyone in as a fixed user. Use OIDC in production.',
		});
	}
	if (sel.storage === 'memory') {
		warnings.push({
			level: 'danger',
			title: 'Storage is volatile',
			message:
				'The in-memory store loses all data on restart. Use s3 or gcs for anything you keep.',
		});
	}
	if (sel.storage === 'fs') {
		warnings.push({
			level: 'warning',
			title: 'Filesystem storage is single-replica',
			message:
				'Conditional writes are enforced within one server process — run exactly one replica, and in containers mount a persistent volume at the storage root. Use s3 or gcs for multi-replica deployments.',
		});
	}
	if (sel.compute === 'local') {
		warnings.push({
			level: 'warning',
			title: 'Local compute has no isolation',
			message:
				'Kernels run as host subprocesses — dev only. Use docker, kubernetes, modal, coreweave, or e2b in production.',
		});
	}
	if (sel.compute === 'none') {
		warnings.push({
			level: 'info',
			title: 'No compute backend',
			message:
				'Notebooks are browsable, but kernels will not start until you choose a compute backend.',
		});
	}
	return warnings;
}

// --- LIBRARY: programmatic wiring ---

const AUTH_BIND: Record<string, (rhs: string) => string> = {
	oidc: (rhs) => `const { authenticator, routes: authRoutes } = ${rhs};`,
	dev: (rhs) => `const authenticator = ${rhs};\nconst authRoutes = undefined;`,
};

export function generateLibrary(sel: WizardSelection): string {
	const values = effective(sel);
	const resolve = (id: string): string => resolveValue(id, values);

	const storage = STORAGE_WIRING[sel.storage];
	const compute = COMPUTE_WIRING[sel.compute];
	const auth = AUTH_WIRING[sel.auth];
	if (!storage || !compute || !auth) {
		throw new Error(`No library wiring for ${sel.storage}/${sel.compute}/${sel.auth}`);
	}

	const imports = [
		`import { createApi } from '@marimo-hub/api';`,
		`import { createServices } from '@marimo-hub/core';`,
		...storage.imports,
		...compute.imports,
		...auth.imports,
	];
	const dedupedImports = [...new Set(imports)];

	const persist = resolve('MARIMOHUB_PERSIST_WORKSPACE') || 'source';
	const bind = AUTH_BIND[sel.auth] ?? ((rhs: string) => `const authResult = ${rhs};`);

	// Managed AI is an optional `ai` dep (a plain config object, not an adapter),
	// only emitted when an upstream is selected.
	const aiOn = sel.ai === 'openai-compatible';
	const aiDecl = aiOn
		? [
				`const ai = {`,
				`\tupstreamBaseUrl: process.env.MARIMOHUB_AI_UPSTREAM_BASE_URL!,`,
				`\tupstreamApiKey: process.env.MARIMOHUB_AI_UPSTREAM_API_KEY!,`,
				`\tmodel: process.env.MARIMOHUB_AI_MODEL!,`,
				`\tsigningSecret: process.env.MARIMOHUB_AUTH_SESSION_SECRET!,`,
				`};`,
				``,
			]
		: [];

	const body = [
		`const bucket = ${storage.rhs(resolve)};`,
		``,
		`const compute = ${compute.rhs(resolve)};`,
		``,
		bind(auth.rhs(resolve)),
		``,
		...aiDecl,
		`const app = createApi({`,
		`\tservices: createServices(bucket),`,
		`\tbucket,`,
		`\tcompute,`,
		`\tauthenticator,`,
		`\tauthRoutes,`,
		...(aiOn ? [`\tai,`] : []),
		`\tsandbox: {`,
		`\t\tbucket: {`,
		`\t\t\tname: process.env.MARIMOHUB_STORAGE_S3_BUCKET ?? '',`,
		`\t\t\tendpoint: process.env.MARIMOHUB_STORAGE_S3_ENDPOINT ?? '',`,
		`\t\t},`,
		`\t\thostname: process.env.MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME ?? '',`,
		`\t\tworkdir: process.env.MARIMOHUB_COMPUTE_WORKDIR ?? '/workspace',`,
		`\t\tpersistWorkspace: ${JSON.stringify(persist)},`,
		`\t},`,
		`\tpolicy: {},`,
		`});`,
	];

	return [...dedupedImports, ``, ...body].join('\n');
}
