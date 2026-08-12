import format from 'pg-format';

export function sqlIdentifier(value: string): string {
	return format.ident(value);
}

export function sqlLiteral(value: string): string {
	return format.literal(value);
}
