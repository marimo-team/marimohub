export function isValidMetadataIdentifier(value: string, maxBytes: number): boolean {
	return (
		value.length > 0 &&
		Buffer.byteLength(value) <= maxBytes &&
		!value.includes('\0') &&
		Buffer.from(value).toString('utf8') === value
	);
}
