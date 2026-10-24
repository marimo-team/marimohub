import { z } from 'zod';

// Keep persisted timestamps and API inputs compatible when Zod changes its ISO defaults.
const UTC_TIMESTAMP =
	/^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z))$/;
const ULID = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;

export function utcTimestamp(error = 'Invalid ISO datetime') {
	return z.stringFormat('datetime', UTC_TIMESTAMP, { error });
}

export function ulidString() {
	return z.stringFormat('ulid', ULID, { error: 'Invalid ULID' });
}
