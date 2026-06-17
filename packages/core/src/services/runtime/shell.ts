/** Shell-escape a single argument for `sh -lc` (single-quote wrap, escape embedded quotes). */
export function shellQuote(arg: string): string {
	return `'${arg.replaceAll("'", `'\\''`)}'`;
}
