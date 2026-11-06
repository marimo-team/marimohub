export const AMBIENT_ENV_DESCRIPTION =
	'Export shared vendor variables for automatic connections. Conflicting values prevent notebook startup.';

export const AMBIENT_ENV_CONFLICT_HELP =
	'Disable "Ambient env" in advanced settings on all but one connection. Namespaced settings remain available.';

export const SINGLE_INSTANCE_CONFLICT_HELP =
	'Give them the same settings or enable only one of them.';

export const INTEGRATION_TEST_HELP =
	'Connection tests do not check conflicts between integrations.';

/** Kinds without an `ambient_env` switch always export their shared variables. */
export function sharedEnvironmentConflictHelp(ambientEnvToggle: boolean): string {
	return ambientEnvToggle ? AMBIENT_ENV_CONFLICT_HELP : SINGLE_INSTANCE_CONFLICT_HELP;
}
