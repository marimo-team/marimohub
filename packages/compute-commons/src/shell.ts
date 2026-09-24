/** Embedded single quotes must close, escape, and reopen the shell string. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function withEnvPrefix(
	cmd: string,
	env: Record<string, string>,
	defaults: Record<string, string> = {},
): string {
	for (const name of [...Object.keys(env), ...Object.keys(defaults)]) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Invalid environment name');
	}
	const forced = Object.keys(env).map((k) => `export ${k}=${shellQuote(env[k])}; `);
	const guarded = Object.keys(defaults).map(
		(k) => `[ -n "\${${k}+x}" ] || export ${k}=${shellQuote(defaults[k])}; `,
	);
	return forced.join('') + guarded.join('') + cmd;
}
