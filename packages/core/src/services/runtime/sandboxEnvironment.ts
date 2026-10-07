/**
 * Structural subset of `SessionEnv`: importing the provisioner here would pull
 * the whole runtime into every consumer of the env-name constants.
 */
interface SessionEnvLike {
	files?: { path: string; content: string }[];
	vars: Record<string, string>;
	defaults: Record<string, string>;
}

export const SANDBOX_CONTEXT_FILE_ENV = 'MARIMOHUB_CONTEXT_FILE';
export const SANDBOX_INTEGRATIONS_DIR_ENV = 'MARIMOHUB_INTEGRATIONS_DIR';
/** Secondary surfaces only. */
export const SURFACE_KERNEL_URL_ENV = 'MARIMOHUB_KERNEL_URL';
/** Secondary surfaces only. */
export const SURFACE_KERNEL_TOKEN_FILE_ENV = 'MARIMOHUB_KERNEL_TOKEN_FILE';
export const BRIDGE_PARENT_ORIGIN_ENV = 'MARIMOHUB_BRIDGE_PARENT_ORIGIN';
export const BRIDGE_INSTALL_TIMEOUT_MS_ENV = 'MARIMOHUB_BRIDGE_INSTALL_TIMEOUT_MS';
export const BRIDGE_STARTUP_DEADLINE_MS_ENV = 'MARIMOHUB_BRIDGE_STARTUP_DEADLINE_MS';

/** Every `MARIMOHUB_*` name Hub itself sets in a sandbox process. */
export const HUB_SANDBOX_ENV = [
	SANDBOX_CONTEXT_FILE_ENV,
	SANDBOX_INTEGRATIONS_DIR_ENV,
	SURFACE_KERNEL_URL_ENV,
	SURFACE_KERNEL_TOKEN_FILE_ENV,
	BRIDGE_PARENT_ORIGIN_ENV,
	BRIDGE_INSTALL_TIMEOUT_MS_ENV,
	BRIDGE_STARTUP_DEADLINE_MS_ENV,
] as const;

/**
 * Hub points marimo's config, cache, and state at `/tmp` (see marimoConfig.ts).
 * Config is forced because it carries policy; cache and state are fallbacks an
 * operator's image may set, but never a project.
 */
export const HUB_XDG_ENV = ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'] as const;

/**
 * marimo settings the Hub sandbox image pins with `ENV`
 * (images/marimo-sandbox/Dockerfile; a drift test keeps the two in sync).
 */
export const SANDBOX_IMAGE_MARIMO_ENV = [
	'MARIMO_VERSION',
	'MARIMO_SKIP_UPDATE_CHECK',
	'_MARIMO_APP_OVERLOAD_AUTO_DOWNLOAD',
] as const;

/** Names marimo reads as its own settings. */
export function isMarimoSettingName(name: string): boolean {
	return name.startsWith('MARIMO_');
}

/**
 * Project-supplied marimo settings become `defaults` so the sandbox image and
 * deployment-wide values (e.g. `MARIMO_RESTRICT_SHARING`) keep precedence; a
 * project can only fill in settings the operator did not pin.
 */
export function projectSessionEnv(render: {
	files?: SessionEnvLike['files'];
	vars: Record<string, string>;
}): SessionEnvLike {
	const vars: Record<string, string> = {};
	const defaults: Record<string, string> = {};
	for (const [name, value] of Object.entries(render.vars)) {
		(isMarimoSettingName(name) ? defaults : vars)[name] = value;
	}
	return { files: render.files, vars, defaults };
}
