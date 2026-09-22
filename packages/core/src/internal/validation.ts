export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

export function assertPositiveInteger(name: string, value: number): void {
	if (!Number.isInteger(value) || value < 1) {
		throw new RangeError(`${name} must be a positive integer`);
	}
}

export function assertPositiveIntegers(values: Readonly<Record<string, number>>): void {
	for (const [name, value] of Object.entries(values)) assertPositiveInteger(name, value);
}

export function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) return true;
	}
	return false;
}
