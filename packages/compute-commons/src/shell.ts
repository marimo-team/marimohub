/** Embedded single quotes must close, escape, and reopen the shell string. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
