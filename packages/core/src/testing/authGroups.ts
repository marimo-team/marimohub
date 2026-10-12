import {
	MAX_AUTH_GROUP_ID_LENGTH,
	MAX_AUTH_GROUPS,
	MAX_AUTH_GROUPS_JSON_BYTES,
} from '../ports/auth';

/** Exactly `MAX_AUTH_GROUPS` distinct, valid group IDs. */
export function groupsAtCountLimit(prefix = 'group-'): string[] {
	return Array.from({ length: MAX_AUTH_GROUPS }, (_, i) => `${prefix}${i}`);
}

/** One more distinct group ID than `MAX_AUTH_GROUPS`, each well under the byte budget. */
export function groupsExceedingCount(prefix = 'group-'): string[] {
	return Array.from({ length: MAX_AUTH_GROUPS + 1 }, (_, i) => `${prefix}${i}`);
}

/**
 * Fewer than `MAX_AUTH_GROUPS` maximum-length IDs whose normalized JSON exceeds
 * `MAX_AUTH_GROUPS_JSON_BYTES`, so only the byte limit rejects them.
 */
export function groupsExceedingBytes(prefix = 'group-'): string[] {
	const groups: string[] = [];
	const encoder = new TextEncoder();
	// Room for the longest counter keeps every ID exactly at the length limit.
	if (`${prefix}${MAX_AUTH_GROUPS}-`.length > MAX_AUTH_GROUP_ID_LENGTH)
		throw new Error('byte overflow fixture prefix is too long');
	while (encoder.encode(JSON.stringify(groups)).byteLength <= MAX_AUTH_GROUPS_JSON_BYTES) {
		const id = `${prefix}${groups.length}-`;
		groups.push(id.padEnd(MAX_AUTH_GROUP_ID_LENGTH, 'x'));
	}
	if (groups.length >= MAX_AUTH_GROUPS)
		throw new Error('byte overflow fixture hit the count limit');
	return groups;
}
