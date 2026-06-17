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
});
