import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServices } from '@marimo-hub/core';
import { ACTOR, fakeComputeFrom, makeFakeSandbox } from '@marimo-hub/core/testing';
import {
	createInitializedBucket,
	createTestApi,
	expectOk,
	makeTestWif,
} from '@marimo-hub/api/testing';

let server: Server | undefined;
let client: S3Client | undefined;

afterEach(async () => {
	client?.destroy();
	await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

async function fixture(lifetimeMs?: number) {
	let now = Date.now();
	vi.spyOn(Date, 'now').mockImplementation(() => now);
	const exchange = vi.fn(async () => ({
		accessKeyId: `AK${exchange.mock.calls.length}`,
		secretAccessKey: 'SK',
		...(lifetimeMs === undefined ? {} : { expiration: new Date(now + lifetimeMs).toISOString() }),
	}));
	const bucket = await createInitializedBucket();
	const services = createServices(bucket);
	const project = await services.projects.createProject({ name: 'SDK', description: '' }, ACTOR);
	await services.projects.updateProject(project.id, { federation: { enabled: true } }, ACTOR);
	const notebook = await services.notebooks.createNotebook(
		project.id,
		{ title: 'SDK', description: '', code: 'import marimo' },
		ACTOR,
	);
	const { instance, calls } = makeFakeSandbox();
	const { app, request } = createTestApi({
		bucket,
		compute: fakeComputeFrom(instance),
		deps: {
			wif: makeTestWif({ exchange, credentialsEndpoint: true }),
			sandbox: {
				bucket: { name: 'test', endpoint: '' },
				hostname: 'localhost',
				workdir: '/workspace',
				persistWorkspace: 'source',
				appBaseUrl: 'https://hub.example.com',
			},
		},
	});
	await expectOk(
		await request('POST', `/projects/${project.id}/notebooks/${notebook.id}/sessions`),
	);
	const env = calls.setEnvVars.find((vars) => vars.AWS_CONTAINER_AUTHORIZATION_TOKEN)!;
	let fetches = 0;
	server = createServer(async (req, res) => {
		fetches++;
		const response = await app.request('/api/wif/v1/credentials', {
			headers: { authorization: req.headers.authorization ?? '' },
		});
		res.writeHead(response.status, { 'content-type': 'application/json' });
		res.end(await response.text());
	});
	await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Missing test listener');
	for (const name of [
		'AWS_ACCESS_KEY_ID',
		'AWS_SECRET_ACCESS_KEY',
		'AWS_SESSION_TOKEN',
		'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
		'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
		'AWS_WEB_IDENTITY_TOKEN_FILE',
		'AWS_ROLE_ARN',
	]) {
		vi.stubEnv(name, undefined);
	}
	vi.stubEnv('AWS_PROFILE', 'marimohub-wif-sdk-test');
	vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', '/nonexistent/marimohub-wif-credentials');
	vi.stubEnv('AWS_CONFIG_FILE', '/nonexistent/marimohub-wif-config');
	vi.stubEnv(
		'AWS_CONTAINER_CREDENTIALS_FULL_URI',
		`http://127.0.0.1:${address.port}/api/wif/v1/credentials`,
	);
	vi.stubEnv('AWS_CONTAINER_AUTHORIZATION_TOKEN', env.AWS_CONTAINER_AUTHORIZATION_TOKEN);
	client = new S3Client({ region: 'us-east-1', maxAttempts: 1 });
	return {
		credentials: client.config.credentials,
		exchange,
		fetches: () => fetches,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe('AWS SDK container credential refresh', () => {
	it('reuses credentials and fetches fresh keys near expiry', async () => {
		const { credentials, exchange, fetches, advance } = await fixture(60 * 60_000);
		expect((await credentials()).accessKeyId).toBe('AK1');
		for (let i = 0; i < 5; i++) await credentials();
		expect(fetches()).toBe(1);
		advance(56 * 60_000);
		await vi.waitFor(async () => expect((await credentials()).accessKeyId).toBe('AK2'));
		expect(exchange).toHaveBeenCalledTimes(2);
	});

	it('preserves a short broker lifetime and refreshes before it expires', async () => {
		const { credentials, exchange, advance } = await fixture(10 * 60_000);
		const first = await credentials();
		expect(first.expiration!.getTime() - Date.now()).toBe(10 * 60_000);
		advance(6 * 60_000);
		await vi.waitFor(async () => expect((await credentials()).accessKeyId).toBe('AK2'));
		expect(exchange).toHaveBeenCalledTimes(2);
	});

	it('fails credential resolution when the broker omits expiration', async () => {
		const { credentials } = await fixture();
		await expect(credentials()).rejects.toThrow();
	});
});
