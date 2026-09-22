import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../../errors';
import { icebergRest } from './icebergRest';

const base = {
	uri: 'https://catalog.internal/api/catalog',
	auth: { method: 'bearer_token', token: 'tok' },
	storage: { scheme: 's3', region: 'us-east-1' },
};

describe('iceberg_rest extra_properties', () => {
	it.each([
		{ name: 'a credential-bearing header', key: 'header.Cookie', value: 'session=abc' },
		{
			name: 'a case-variant access-delegation header',
			key: 'header.x-iceberg-access-delegation',
			value: 'remote-signing',
		},
	])('rejects $name', ({ key, value }) => {
		const config = icebergRest.configSchema.parse({
			...base,
			extra_properties: { [key]: value },
		});
		expect(() => icebergRest.validate?.(config)).toThrow(ValidationError);
	});
});
