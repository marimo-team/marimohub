/**
 * Wizard model — derived from the single source of truth `CONFIG_SPEC`
 * (`@marimo-hub/config/spec`, pure data, imports no adapters) plus the small
 * amount of presentation/codegen metadata the env surface can't express.
 *
 * Add a backend or option by editing the data here (and `CONFIG_SPEC`); the
 * components and generators are fully data-driven and need no changes.
 */
import { CONFIG_SPEC } from '@marimo-hub/config/spec';
import type { ConfigBackend, ConfigGroup, ConfigVar } from '@marimo-hub/config/spec';

export type { ConfigBackend, ConfigGroup, ConfigVar };

function group(name: string): ConfigGroup {
	const found = CONFIG_SPEC.find((g) => g.name === name);
	if (!found) throw new Error(`Wizard spec: missing config group "${name}"`);
	return found;
}

const STORAGE = group('Storage');
const COMPUTE = group('Compute');
const AUTH = group('Auth');
const AI = group('Managed AI');
const SERVER = group('Server / API');

/** Compute vars read regardless of backend (the pseudo-backend with no selector). */
export const SHARED_COMPUTE_VARS: ConfigVar[] =
	COMPUTE.backends.find((b) => !b.selectorValue)?.vars ?? [];

export type GroupKey = 'storage' | 'compute' | 'auth' | 'ai';

/** The selected backend value per port — the subset of the selection the Setup section needs. */
export type WizardSelectionKeys = Record<GroupKey, string>;

export interface SelectableBackend {
	value: string;
	name: string;
	description?: string;
	icon: string;
	vars: ConfigVar[];
}

export interface SelectableGroup {
	key: GroupKey;
	label: string;
	selector: string;
	default: string;
	backends: SelectableBackend[];
}

/** Emoji per backend, purely cosmetic. Falls back to a neutral marker. */
const ICONS: Record<string, string> = {
	// storage
	s3: '🪣',
	gcs: '☁️',
	azure: '🔷',
	fs: '📁',
	memory: '🧪',
	library: '🧩',
	// compute
	modal: '🚀',
	coreweave: '🧶',
	wandb: '🪄',
	docker: '🐳',
	podman: '🦭',
	e2b: '📦',
	kubernetes: '☸️',
	local: '💻',
	none: '🚫',
	// auth
	oidc: '🔐',
	'proxy-header': '🛡️',
	dev: '🛠️',
	// managed ai
	'openai-compatible': '🤖',
};

/**
 * Turn a `CONFIG_SPEC` group into the wizard's selectable shape. Workers-only
 * backends (empty `vars`, wired by hand) are dropped — except compute `none`,
 * which is a real self-host choice.
 */
function selectable(
	key: GroupKey,
	label: string,
	cfg: ConfigGroup,
	defaultValue: string,
): SelectableGroup {
	const backends = cfg.backends
		.filter((b): b is ConfigBackend & { selectorValue: string } => Boolean(b.selectorValue))
		.filter((b) => b.vars.length > 0 || b.selectorValue === 'none')
		.map((b) => ({
			value: b.selectorValue,
			name: b.name,
			description: b.description,
			icon: ICONS[b.selectorValue] ?? '•',
			vars: b.vars,
		}));
	return { key, label, selector: cfg.selector ?? '', default: defaultValue, backends };
}

export const SELECTABLE_GROUPS: SelectableGroup[] = [
	selectable('storage', 'Storage', STORAGE, 's3'),
	selectable('compute', 'Compute', COMPUTE, 'modal'),
	selectable('auth', 'Auth', AUTH, 'oidc'),
	selectable('ai', 'Managed AI', AI, 'none'),
];

/** Look up a backend definition for a selected value. */
export function backendFor(key: GroupKey, value: string): SelectableBackend | undefined {
	return SELECTABLE_GROUPS.find((g) => g.key === key)?.backends.find((b) => b.value === value);
}

/** A non-selector option surfaced as its own control, pointing at a `CONFIG_SPEC` var. */
export interface ExtraOption {
	/** The env var id this option drives. */
	id: string;
	label: string;
	description: string;
	/** `enum` renders a segmented choice; `text` a free input. */
	kind: 'enum' | 'text';
	/** Allowed values for `enum`. */
	choices?: string[];
	default: string;
}

function serverVar(id: string): ConfigVar {
	const v = SERVER.backends[0]?.vars.find((x) => x.id === id);
	if (!v) throw new Error(`Wizard spec: missing server var "${id}"`);
	return v;
}

/** Every declared var, keyed by id (no selectors) — for value resolution. */
export const ALL_VARS_BY_ID: Map<string, ConfigVar> = new Map(
	CONFIG_SPEC.flatMap((g) => g.backends.flatMap((b) => b.vars)).map((v) => [v.id, v]),
);

/** Extra toggles. Append entries here to surface more options — no UI changes needed. */
export const EXTRA_OPTIONS: ExtraOption[] = [
	{
		id: serverVar('MARIMOHUB_EDITOR_SANDBOX_SHARING').id,
		label: 'Editor sandbox sharing',
		description: serverVar('MARIMOHUB_EDITOR_SANDBOX_SHARING').description,
		kind: 'enum',
		choices: ['shared', 'exclusive'],
		default: 'shared',
	},
	{
		id: serverVar('MARIMOHUB_PERSIST_WORKSPACE').id,
		label: 'Persist workspace',
		description: serverVar('MARIMOHUB_PERSIST_WORKSPACE').description,
		kind: 'enum',
		choices: ['source', 'workspace'],
		default: 'source',
	},
	{
		id: 'MARIMOHUB_COMPUTE_IMAGE',
		label: 'Sandbox image',
		description:
			SHARED_COMPUTE_VARS.find((v) => v.id === 'MARIMOHUB_COMPUTE_IMAGE')?.description ?? '',
		kind: 'text',
		default: '',
	},
];

const ALL_BACKEND_VAR_IDS = new Set([
	...SELECTABLE_GROUPS.flatMap((g) => g.backends.flatMap((b) => b.vars.map((v) => v.id))),
	...SHARED_COMPUTE_VARS.map((v) => v.id),
]);

/** Extra options that live in the Server group — rendered as their own section. */
export const SERVER_EXTRA_VARS: ConfigVar[] = EXTRA_OPTIONS.filter(
	(o) => !ALL_BACKEND_VAR_IDS.has(o.id),
).map((o) => serverVar(o.id));

/**
 * LIBRARY-tab wiring per backend, mirroring `packages/config/src/index.ts`
 * (the source of truth for env → adapter construction; keep in sync). Each entry
 * names the adapter import and renders its constructor RHS from a value resolver.
 */
export interface BackendWiring {
	imports: string[];
	/** The right-hand-side expression, e.g. `new S3Storage({ ... })`. */
	rhs: (resolve: (id: string) => string) => string;
}

/** Quote a string literal for embedding in generated code. */
const q = (s: string): string => JSON.stringify(s);

/** `process.env.X` reference (with non-null assertion for required/secret values). */
const env = (id: string, required = false): string => `process.env.${id}${required ? '!' : ''}`;

/** Inline a non-secret value as a literal when known, else read from env. */
function lit(id: string, resolve: (id: string) => string): string {
	const v = resolve(id);
	return v ? q(v) : env(id);
}

export const STORAGE_WIRING: Record<string, BackendWiring> = {
	s3: {
		imports: [`import { S3Storage } from '@marimo-hub/storage-s3';`],
		rhs: (r) =>
			[
				`new S3Storage({`,
				`\tbucket: ${env('MARIMOHUB_STORAGE_S3_BUCKET', true)},`,
				`\tendpoint: ${lit('MARIMOHUB_STORAGE_S3_ENDPOINT', r)},`,
				`\tregion: ${lit('MARIMOHUB_STORAGE_S3_REGION', r)},`,
				`\tforcePathStyle: ${r('MARIMOHUB_STORAGE_S3_FORCE_PATH_STYLE') === 'true'},`,
				`})`,
			].join('\n'),
	},
	gcs: {
		imports: [`import { GcsStorage } from '@marimo-hub/storage-gcs';`],
		rhs: () =>
			[
				`new GcsStorage({`,
				`\tbucket: ${env('MARIMOHUB_STORAGE_GCS_BUCKET', true)},`,
				`\tserviceAccountKey: ${env('MARIMOHUB_STORAGE_GCS_SA_KEY')},`,
				`\taccessToken: ${env('MARIMOHUB_STORAGE_GCS_ACCESS_TOKEN')},`,
				`})`,
			].join('\n'),
	},
	azure: {
		imports: [`import { AzureStorage } from '@marimo-hub/storage-azure';`],
		rhs: () =>
			[
				`new AzureStorage(`,
				`\t${env('MARIMOHUB_STORAGE_AZURE_CONNECTION_STRING')}`,
				`\t\t? {`,
				`\t\t\tcontainer: ${env('MARIMOHUB_STORAGE_AZURE_CONTAINER', true)},`,
				`\t\t\tconnectionString: ${env('MARIMOHUB_STORAGE_AZURE_CONNECTION_STRING', true)},`,
				`\t\t}`,
				`\t\t: {`,
				`\t\t\tcontainer: ${env('MARIMOHUB_STORAGE_AZURE_CONTAINER', true)},`,
				`\t\t\taccountUrl: ${env('MARIMOHUB_STORAGE_AZURE_ACCOUNT_URL', true)},`,
				`\t\t},`,
				`)`,
			].join('\n'),
	},
	fs: {
		imports: [`import { FsStorage } from '@marimo-hub/storage-fs';`],
		rhs: () =>
			[`new FsStorage({`, `\troot: ${env('MARIMOHUB_STORAGE_FS_ROOT', true)},`, `})`].join('\n'),
	},
	memory: {
		imports: [`import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';`],
		rhs: () => `new MemoryBucket()`,
	},
};

export const COMPUTE_WIRING: Record<string, BackendWiring> = {
	modal: {
		imports: [`import { ModalCompute } from '@marimo-hub/compute-modal';`],
		rhs: () =>
			[
				`new ModalCompute({`,
				`\ttokenId: ${env('MARIMOHUB_COMPUTE_MODAL_TOKEN_ID', true)},`,
				`\ttokenSecret: ${env('MARIMOHUB_COMPUTE_MODAL_TOKEN_SECRET', true)},`,
				`\timage: ${env('MARIMOHUB_COMPUTE_IMAGE', true)},`,
				`\tidleTimeout: ${env('MARIMOHUB_COMPUTE_IDLE_TIMEOUT')},`,
				`})`,
			].join('\n'),
	},
	coreweave: {
		imports: [`import { CoreWeaveCompute } from '@marimo-hub/compute-coreweave';`],
		rhs: () =>
			[
				`new CoreWeaveCompute({`,
				`\tapiKey: ${env('MARIMOHUB_COMPUTE_COREWEAVE_API_KEY', true)},`,
				`\timage: ${env('MARIMOHUB_COMPUTE_IMAGE')},`,
				`})`,
			].join('\n'),
	},
	wandb: {
		imports: [`import { createWandbCompute } from '@marimo-hub/compute-coreweave/wandb';`],
		rhs: (r) =>
			[
				`createWandbCompute({`,
				`\tapiKey: ${env('MARIMOHUB_COMPUTE_WANDB_API_KEY', true)},`,
				`\tentity: ${lit('MARIMOHUB_COMPUTE_WANDB_ENTITY', r)},`,
				`\tproject: ${lit('MARIMOHUB_COMPUTE_WANDB_PROJECT', r)},`,
				`\timage: ${env('MARIMOHUB_COMPUTE_IMAGE')},`,
				`})`,
			].join('\n'),
	},
	docker: {
		imports: [`import { DockerCompute } from '@marimo-hub/compute-container/docker';`],
		rhs: (r) =>
			[
				`new DockerCompute({`,
				`\timage: ${env('MARIMOHUB_COMPUTE_IMAGE')},`,
				`\thost: ${lit('MARIMOHUB_COMPUTE_DOCKER_HOST', r)},`,
				`\tbindHost: ${lit('MARIMOHUB_COMPUTE_DOCKER_BIND_HOST', r)},`,
				`})`,
			].join('\n'),
	},
	podman: {
		imports: [`import { PodmanCompute } from '@marimo-hub/compute-container/podman';`],
		rhs: (r) =>
			[
				`new PodmanCompute({`,
				`\timage: ${env('MARIMOHUB_COMPUTE_IMAGE')},`,
				`\thost: ${lit('MARIMOHUB_COMPUTE_PODMAN_HOST', r)},`,
				`\tbindHost: ${lit('MARIMOHUB_COMPUTE_PODMAN_BIND_HOST', r)},`,
				`\tnetwork: ${lit('MARIMOHUB_COMPUTE_PODMAN_NETWORK', r)},`,
				`})`,
			].join('\n'),
	},
	e2b: {
		imports: [`import { E2bCompute } from '@marimo-hub/compute-e2b';`],
		rhs: () =>
			[
				`new E2bCompute({`,
				`\tapiKey: ${env('MARIMOHUB_COMPUTE_E2B_API_KEY', true)},`,
				`\ttemplate: process.env.MARIMOHUB_COMPUTE_E2B_TEMPLATE ?? process.env.MARIMOHUB_COMPUTE_IMAGE,`,
				`})`,
			].join('\n'),
	},
	kubernetes: {
		imports: [
			`import { KubernetesCompute, parseIngressAnnotations, resolveIngressTlsMode } from '@marimo-hub/compute-kubernetes';`,
		],
		rhs: (r) =>
			[
				`new KubernetesCompute({`,
				`\tnamespace: ${lit('MARIMOHUB_COMPUTE_KUBERNETES_NAMESPACE', r)},`,
				`\timage: ${env('MARIMOHUB_COMPUTE_IMAGE')},`,
				`\thostname: ${env('MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME')},`,
				`\tingressClassName: ${env('MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_CLASS')},`,
				`\tingressAnnotations: parseIngressAnnotations(`,
				`\t\tprocess.env.MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_ANNOTATIONS,`,
				`\t),`,
				`\tingressTlsMode: resolveIngressTlsMode(`,
				`\t\tprocess.env.MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_TLS_MODE,`,
				`\t\tprocess.env.MARIMOHUB_COMPUTE_KUBERNETES_TLS_SECRET,`,
				`\t),`,
				`\ttlsSecretName: ${env('MARIMOHUB_COMPUTE_KUBERNETES_TLS_SECRET')},`,
				`})`,
			].join('\n'),
	},
	local: {
		imports: [`import { LocalCompute } from '@marimo-hub/compute-local';`],
		rhs: (r) =>
			[
				`new LocalCompute({`,
				`\thost: ${lit('MARIMOHUB_COMPUTE_LOCAL_HOST', r)},`,
				`\tbindHost: ${lit('MARIMOHUB_COMPUTE_LOCAL_BIND_HOST', r)},`,
				`})`,
			].join('\n'),
	},
	none: {
		imports: [],
		rhs: () =>
			[
				`{`,
				`\tcreate() {`,
				`\t\tthrow new Error('No compute backend configured.');`,
				`\t},`,
				`\tasync proxy() {`,
				`\t\treturn null;`,
				`\t},`,
				`}`,
			].join('\n'),
	},
};

export const AUTH_WIRING: Record<string, BackendWiring> = {
	oidc: {
		imports: [`import { createOidcAuth } from '@marimo-hub/auth-oidc';`],
		rhs: () =>
			[
				`createOidcAuth({`,
				`\tissuer: ${env('MARIMOHUB_AUTH_OIDC_ISSUER', true)},`,
				`\tclientId: ${env('MARIMOHUB_AUTH_OIDC_CLIENT_ID', true)},`,
				`\tclientSecret: ${env('MARIMOHUB_AUTH_OIDC_CLIENT_SECRET', true)},`,
				`\tredirectUri: ${env('MARIMOHUB_AUTH_OIDC_REDIRECT_URI', true)},`,
				`\tsessionSecret: ${env('MARIMOHUB_AUTH_SESSION_SECRET', true)},`,
				`\tallowedEmailDomains: (process.env.MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS ?? '').split(','),`,
				`})`,
			].join('\n'),
	},
	'proxy-header': {
		imports: [`import { ProxyHeaderAuthenticator } from '@marimo-hub/auth-proxy-header';`],
		rhs: () =>
			[
				`new ProxyHeaderAuthenticator({`,
				`\tmode: 'headers',`,
				`\theaders: (`,
				`\t\tprocess.env.MARIMOHUB_AUTH_PROXY_HEADER ??`,
				`\t\t'X-Forwarded-Email,X-Forwarded-User'`,
				`\t)`,
				`\t\t.split(',')`,
				`\t\t.map((header) => header.trim()) as [string, string?],`,
				`\tallowedEmailDomains: (() => {`,
				`\t\tconst value = process.env.MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS?.trim();`,
				`\t\tif (!value) {`,
				`\t\t\tthrow new Error('MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS is required.');`,
				`\t\t}`,
				`\t\treturn value.split(',');`,
				`\t})(),`,
				`})`,
			].join('\n'),
	},
	dev: {
		imports: [`import { DevAuthenticator } from '@marimo-hub/auth-dev';`],
		rhs: (r) =>
			[
				`new DevAuthenticator({`,
				`\tuserId: ${lit('MARIMOHUB_AUTH_DEV_USER_ID', r)},`,
				`\temail: ${lit('MARIMOHUB_AUTH_DEV_EMAIL', r)},`,
				`})`,
			].join('\n'),
	},
};
