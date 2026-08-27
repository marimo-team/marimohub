import type { DataQueryConnection } from './contracts';

/**
 * Values shorter than this are skipped: they are not meaningful secrets and
 * replacing them would shred unrelated text.
 */
const MIN_SECRET_LENGTH = 4;
const MAX_MESSAGE_LENGTH = 500;

/**
 * Scrubs every connection-provided secret value from an executor error message
 * before it can reach a log line or the API error envelope. Collection is
 * deliberately broad — every string in the connection's secret-bearing
 * material is treated as a secret, so a new field fails closed.
 */
export function redactConnectionSecrets(message: string, connection: DataQueryConnection): string {
	const secrets = new Set<string>(Object.values(connection.vars));
	for (const file of connection.files) secrets.add(file.content);
	if (connection.plan) {
		for (const statement of [...connection.plan.setup, ...(connection.plan.cleanup ?? [])]) {
			for (const param of statement.params ?? []) {
				if (typeof param === 'string') secrets.add(param);
			}
		}
		collectStrings(connection.plan.httpAccess, secrets);
	}
	let redacted = message;
	const ordered = [...secrets]
		.filter((value) => value.length >= MIN_SECRET_LENGTH)
		.sort((left, right) => right.length - left.length);
	for (const secret of ordered) redacted = redacted.replaceAll(secret, '[redacted]');
	return redacted.length > MAX_MESSAGE_LENGTH
		? `${redacted.slice(0, MAX_MESSAGE_LENGTH)}…`
		: redacted;
}

function collectStrings(value: unknown, into: Set<string>): void {
	if (typeof value === 'string') into.add(value);
	else if (Array.isArray(value)) for (const item of value) collectStrings(item, into);
	else if (value && typeof value === 'object') {
		for (const item of Object.values(value)) collectStrings(item, into);
	}
}
