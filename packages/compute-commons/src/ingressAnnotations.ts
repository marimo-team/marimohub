export const ANNOTATION_NAME = /^[A-Za-z0-9](?:[-_.A-Za-z0-9]*[A-Za-z0-9])?$/;
const DNS_LABEL = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const MAX_ANNOTATIONS_SIZE_BYTES = 256 * 1024;

export function validateAnnotationKey(key: string): void {
	const parts = key.split('/');
	if (parts.length > 2) throw new Error(`invalid annotation key "${key}"`);
	const name = parts.at(-1) ?? '';
	if (name.length > 63 || !ANNOTATION_NAME.test(name)) {
		throw new Error(`invalid annotation name in "${key}"`);
	}
	const prefix = parts.length === 2 ? parts[0] : undefined;
	if (
		prefix !== undefined &&
		(prefix.length > 253 ||
			prefix.split('.').some((label) => label.length > 63 || !DNS_LABEL.test(label)))
	) {
		throw new Error(`invalid DNS prefix in annotation key "${key}"`);
	}
}

export function validateIngressAnnotations(value: unknown): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('expected an object with string values');
	}
	const entries = Object.entries(value);
	const encoder = new TextEncoder();
	let size = 0;
	for (const [key, annotationValue] of entries) {
		if (typeof annotationValue !== 'string') throw new Error('annotation values must be strings');
		validateAnnotationKey(key);
		size += encoder.encode(key).byteLength + encoder.encode(annotationValue).byteLength;
	}
	if (size > MAX_ANNOTATIONS_SIZE_BYTES) {
		throw new Error('annotations exceed the Kubernetes 256 KiB limit');
	}
	return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

export function parseIngressAnnotations(
	raw: string | undefined,
): Record<string, string> | undefined {
	if (raw === undefined || raw.trim() === '') return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error('expected valid JSON');
	}
	return validateIngressAnnotations(parsed);
}
