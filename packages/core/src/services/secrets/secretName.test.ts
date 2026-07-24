import { describe, it, expect } from 'vitest';
import { ValidationError } from '../../errors';
import { assertValidSecretName } from './secretName';

describe('assertValidSecretName', () => {
	it('accepts upper-snake identifiers', () => {
		expect(() => assertValidSecretName('OPENAI_API_KEY')).not.toThrow();
		expect(() => assertValidSecretName('_X')).not.toThrow();
		expect(() => assertValidSecretName('DB_PASSWORD_2')).not.toThrow();
	});

	it.each(['lower', '1ABC', 'A-B', 'A.B', 'FOO BAR', ''])('rejects malformed name %o', (name) => {
		expect(() => assertValidSecretName(name)).toThrow(ValidationError);
	});

	it.each(['PATH', 'HOME', 'AWS_SESSION_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_REGION'])(
		'rejects reserved name %o',
		(name) => {
			expect(() => assertValidSecretName(name)).toThrow(ValidationError);
		},
	);

	it.each(['LD_PRELOAD', 'LD_LIBRARY_PATH', 'PYTHONSTARTUP', 'NODE_OPTIONS', 'BASH_ENV'])(
		'rejects the code-execution vector %o',
		(name) => {
			expect(() => assertValidSecretName(name)).toThrow(ValidationError);
		},
	);

	it.each(['MARIMO_FOO', 'MARIMOHUB_ANYTHING'])('rejects reserved prefix %o', (name) => {
		expect(() => assertValidSecretName(name)).toThrow(ValidationError);
	});

	// A newline-bearing name that slipped through would let an attacker inject a
	// second `KEY=value` line when the env is materialized as text.
	it.each(['FOO\n', 'FOO\nBAR', '\nFOO'])('rejects a name with a newline %o', (name) => {
		expect(() => assertValidSecretName(name)).toThrow(ValidationError);
	});

	it.each(['IFS', 'ENV', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'AWS_SECRET_ACCESS_KEY'])(
		'rejects the reserved injection/credential name %o',
		(name) => {
			expect(() => assertValidSecretName(name)).toThrow(ValidationError);
		},
	);

	// RESERVED_PREFIXES uses startsWith, so the bare token and no-underscore
	// variants must be caught too (not just `MARIMO_...`).
	it.each(['MARIMO', 'MARIMOS'])('rejects the bare/glued reserved prefix %o', (name) => {
		expect(() => assertValidSecretName(name)).toThrow(ValidationError);
	});
});
