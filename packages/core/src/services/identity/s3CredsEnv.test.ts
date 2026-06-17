import { describe, expect, it } from 'vitest';
import { s3CredsToEnv } from './s3CredsEnv';

describe('s3CredsToEnv', () => {
	it('maps creds + endpoint, including the session token and region', () => {
		const env = s3CredsToEnv(
			{
				accessKeyId: 'CWAK',
				secretAccessKey: 'cwsecret',
				sessionToken: 'tok',
				expiration: '2026-01-23T19:03:47Z',
			},
			'https://cwobject.com',
			'us-east-1',
		);
		expect(env).toEqual({
			AWS_ACCESS_KEY_ID: 'CWAK',
			AWS_SECRET_ACCESS_KEY: 'cwsecret',
			AWS_SESSION_TOKEN: 'tok',
			AWS_ENDPOINT_URL_S3: 'https://cwobject.com',
			AWS_REGION: 'us-east-1',
		});
	});

	it('omits the session token and region when absent', () => {
		const env = s3CredsToEnv({ accessKeyId: 'AK', secretAccessKey: 'sk' }, 'https://cwobject.com');
		expect(env).toEqual({
			AWS_ACCESS_KEY_ID: 'AK',
			AWS_SECRET_ACCESS_KEY: 'sk',
			AWS_ENDPOINT_URL_S3: 'https://cwobject.com',
		});
		expect(env).not.toHaveProperty('AWS_SESSION_TOKEN');
		expect(env).not.toHaveProperty('AWS_REGION');
	});

	it('does not set the generic AWS_ENDPOINT_URL (would clobber non-S3 AWS clients)', () => {
		const env = s3CredsToEnv({ accessKeyId: 'AK', secretAccessKey: 'sk' }, 'https://cwobject.com');
		expect(env).not.toHaveProperty('AWS_ENDPOINT_URL');
	});
});
