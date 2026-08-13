export function sqlIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

export function sqlLiteral(value: string): string {
	const escaped = value.replaceAll("'", "''");
	return escaped.includes('\\') ? `E'${escaped.replaceAll('\\', '\\\\')}'` : `'${escaped}'`;
}
