import { describe, expect, it } from 'vitest';
import { ambientS3FromEnv, ambientS3QueryGate } from './ambientS3';

const input = {
	kind: 'iceberg_rest',
	config: {
		storage: {
			scheme: 's3',
			credentials: { method: 'ambient' },
			broker_read_locations: [{ bucket: 'warehouse', prefix: 'tables/' }],
		},
	},
};

describe('ambient S3 SQL policy', () => {
	it('requires a separate SQL opt-in', () => {
		expect(ambientS3FromEnv({})).toBeUndefined();
		expect(
			ambientS3QueryGate({ MARIMOHUB_OBJECT_BROWSER_ALLOW_SERVER_AMBIENT_CREDENTIALS: 'true' })(
				input,
			),
		).toMatchObject({
			ready: false,
			reason: expect.stringContaining('MARIMOHUB_DATA_BROWSER_ALLOW_SERVER_AMBIENT_CREDENTIALS'),
		});
	});

	it('allows opted-in ambient access except to the control-plane bucket', () => {
		const env = { MARIMOHUB_DATA_BROWSER_ALLOW_SERVER_AMBIENT_CREDENTIALS: 'true' };
		expect(ambientS3QueryGate(env)(input)).toBeUndefined();
		expect(ambientS3FromEnv(env)?.credentials).toBeTypeOf('function');
		expect(
			ambientS3QueryGate({ ...env, MARIMOHUB_STORAGE_S3_BUCKET: 'warehouse' })(input),
		).toMatchObject({ ready: false, reason: expect.stringContaining('Control-plane') });
	});

	it('does not gate static, anonymous, or catalog-vended credentials', () => {
		for (const storage of [
			{ ...input.config.storage, credentials: { method: 'static' } },
			{ ...input.config.storage, anonymous: true },
			{ scheme: 'catalog' },
		]) {
			expect(ambientS3QueryGate({})({ ...input, config: { storage } })).toBeUndefined();
		}
	});
});
