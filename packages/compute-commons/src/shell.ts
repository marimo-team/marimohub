/** Embedded single quotes must close, escape, and reopen the shell string. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function withEnvPrefix(
	cmd: string,
	env: Record<string, string>,
	defaults: Record<string, string> = {},
): string {
	const forced = Object.keys(env).map((k) => `export ${k}=${shellQuote(env[k])}; `);
	const guarded = Object.keys(defaults).map(
		(k) => `[ -n "\${${k}:-}" ] || export ${k}=${shellQuote(defaults[k])}; `,
	);
	return forced.join('') + guarded.join('') + cmd;
}
