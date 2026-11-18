export function isStableVersion(value) {
	return (
		typeof value === 'string' &&
		value === value.trim() &&
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
	);
}
