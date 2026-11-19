import { describe, expect, it } from 'vitest';
import { DomainError } from '@marimo-hub/core/errors';
import { storageError } from './errors';

describe('metadata error mapping', () => {
	it.each(['55000', '55P03', '57014', undefined])(
		'maps unavailable storage to 503 (%s) without driver details',
		(code) => {
			const error = storageError(
				Object.assign(new Error('private URL or body'), { code, detail: 'secret' }),
			);
			expect(error).toBeInstanceOf(DomainError);
			expect(error).toMatchObject({
				code: 'SERVICE_UNAVAILABLE',
				status: 503,
				kind: 'unavailable',
			});
			expect(error.message).toBe('Metadata storage unavailable');
			expect(error).not.toHaveProperty('detail');
		},
	);
});
