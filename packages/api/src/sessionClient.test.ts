import { CREDENTIAL_KINDS } from '@marimo-hub/core';
import { describe, expect, it } from 'vitest';
import { sessionClientFor } from './sessionClient';

const REST_CLIENT = {
	sso: 'web',
	development: 'web',
	'personal-access-token': 'cli',
	'external-access-token': 'cli',
	'service-account': 'cli',
} as const;

describe('sessionClientFor', () => {
	it.each(CREDENTIAL_KINDS.flatMap((kind) => [[kind, 'rest'] as const, [kind, 'mcp'] as const]))(
		'%s via %s',
		(kind, via) => {
			expect(sessionClientFor(kind, via)).toBe(via === 'mcp' ? 'mcp' : REST_CLIENT[kind]);
		},
	);
});
