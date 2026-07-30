import { beforeEach, describe, expect, it } from 'vitest';
import { AesGcmSecretCodec, defaultRegistry, ProjectIntegrationsStore } from '@marimo-hub/core';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import { ACTOR, uid } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';

const codec = new AesGcmSecretCodec({ kek: 'route-test-kek-'.padEnd(32, 'x') });

function integrationsDeps(bucket: MemoryBucket) {
	return {
		integrations: new ProjectIntegrationsStore({ bucket, registry: defaultRegistry(), codec }),
	};
}

const PG_CONFIG = {
	host: 'db.internal',
	database: 'analytics',
	username: 'svc',
	password: 'sup3r-secret',
};

describe('Integrations routes', () => {
	let bucket: MemoryBucket;
	let request: ReturnType<typeof createTestApi>['request'];

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		request = createTestApi({ bucket, userId: ACTOR, deps: integrationsDeps(bucket) }).request;
	});

	async function createProject() {
		const data = await expectOk<{ id: string }>(
			await request('POST', '/projects', { name: 'P', description: 'd' }),
			201,
		);
		return data.id;
	}

	async function createPg(pid: string, name = 'prod') {
		return expectOk<{ id: string }>(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 'postgres',
				name,
				config: PG_CONFIG,
			}),
			201,
		);
	}

	it('lists kinds with serializable JSON Schemas and ui hints', async () => {
		const kinds = await expectOk<Record<string, unknown>[]>(
			await request('GET', '/integrations/kinds'),
		);
		expect(kinds.map((k) => String(k.kind)).sort((a, b) => a.localeCompare(b))).toEqual([
			'custom_env',
			'iceberg_bigquery',
			'iceberg_dynamodb',
			'iceberg_glue',
			'iceberg_hive',
			'iceberg_rest',
			'iceberg_sql',
			'postgres',
			'pyspark',
			'trino',
		]);
		const pg = kinds.find((k) => k.kind === 'postgres');
		expect(pg).toMatchObject({
			category: 'database',
			schema_version: 1,
			json_schema: { type: 'object' },
		});
	});

	it('create → get returns a redacted config; the plaintext never appears anywhere', async () => {
		const pid = await createProject();
		const created = await createPg(pid);

		const detail = await expectOk<Record<string, unknown>>(
			await request('GET', `/projects/${pid}/integrations/${created.id}`),
		);
		expect(detail).toMatchObject({
			kind: 'postgres',
			name: 'prod',
			enabled: true,
			current_version: 1,
			config: {
				host: 'db.internal',
				port: 5432, // schema default applied
				password: { $secret: { set: true } },
			},
		});
		expect(JSON.stringify(detail)).not.toContain('sup3r-secret');

		const events = await expectOk<Record<string, unknown>[]>(
			await request('GET', `/projects/${pid}/events`),
		);
		expect(events.map((e) => e.event)).toContain('integration.create');
		expect(JSON.stringify(events)).not.toContain('sup3r-secret');
	});

	it('update with config appends a version; keep-marker preserves the secret', async () => {
		const pid = await createProject();
		const created = await createPg(pid);

		const updated = await expectOk<Record<string, unknown>>(
			await request('PATCH', `/projects/${pid}/integrations/${created.id}`, {
				config: { ...PG_CONFIG, host: 'db2.internal', password: { $secret: { set: true } } },
				change_note: 'moved hosts',
			}),
		);
		expect(updated).toMatchObject({
			current_version: 2,
			config: { host: 'db2.internal', password: { $secret: { set: true } } },
			change_note: 'moved hosts',
		});

		const versions = await expectOk<{ items: { version: number }[]; next_cursor: string | null }>(
			await request('GET', `/projects/${pid}/integrations/${created.id}/versions`),
		);
		expect(versions.items.map((v) => v.version)).toEqual([2, 1]);
		expect(versions.next_cursor).toBeNull();
	});

	it('never writes a replacement secret into the integration audit event', async () => {
		const pid = await createProject();
		const created = await createPg(pid);
		const replacement = 'replacement-secret-not-for-events';
		await expectOk(
			await request('PATCH', `/projects/${pid}/integrations/${created.id}`, {
				config: { ...PG_CONFIG, password: replacement },
			}),
		);

		const events = await expectOk<Record<string, unknown>[]>(
			await request('GET', `/projects/${pid}/events`),
		);
		expect(events.map((event) => event.event)).toContain('integration.update');
		expect(JSON.stringify(events)).not.toContain(replacement);
	});

	it('version history paginates newest-first with a cursor', async () => {
		const pid = await createProject();
		const created = await createPg(pid);
		for (const host of ['a.internal', 'b.internal', 'c.internal']) {
			await expectOk(
				await request('PATCH', `/projects/${pid}/integrations/${created.id}`, {
					config: { ...PG_CONFIG, host, password: { $secret: { set: true } } },
				}),
			);
		}
		const first = await expectOk<{ items: { version: number }[]; next_cursor: string | null }>(
			await request('GET', `/projects/${pid}/integrations/${created.id}/versions?limit=2`),
		);
		expect(first.items.map((v) => v.version)).toEqual([4, 3]);
		expect(first.next_cursor).not.toBeNull();
		const rest = await expectOk<{ items: { version: number }[]; next_cursor: string | null }>(
			await request(
				'GET',
				`/projects/${pid}/integrations/${created.id}/versions?limit=2&cursor=${encodeURIComponent(first.next_cursor ?? '')}`,
			),
		);
		expect(rest.items.map((v) => v.version)).toEqual([2, 1]);
	});

	it('PATCH rejects no-op payloads (422): {} and a change_note without config', async () => {
		const pid = await createProject();
		const created = await createPg(pid);
		await expectError(
			await request('PATCH', `/projects/${pid}/integrations/${created.id}`, {}),
			422,
		);
		await expectError(
			await request('PATCH', `/projects/${pid}/integrations/${created.id}`, {
				change_note: 'orphan note',
			}),
			422,
		);
	});

	it('PATCH honors If-Match: stale token → 412, fresh ETag → 200', async () => {
		const pid = await createProject();
		const created = await createPg(pid);
		await expectError(
			await request(
				'PATCH',
				`/projects/${pid}/integrations/${created.id}`,
				{ enabled: true },
				{ 'if-match': '"1999-01-01T00:00:00.000Z"' },
			),
			412,
		);
		const fresh = await expectOk<{ updated_at: string }>(
			await request('GET', `/projects/${pid}/integrations/${created.id}`),
		);
		await expectOk(
			await request(
				'PATCH',
				`/projects/${pid}/integrations/${created.id}`,
				{ enabled: false },
				{ 'if-match': `"${fresh.updated_at}"` },
			),
		);
	});

	it('enabled toggle and rename append no version', async () => {
		const pid = await createProject();
		const created = await createPg(pid);
		const updated = await expectOk<Record<string, unknown>>(
			await request('PATCH', `/projects/${pid}/integrations/${created.id}`, {
				enabled: false,
				name: 'staging',
			}),
		);
		expect(updated).toMatchObject({ enabled: false, name: 'staging', current_version: 1 });
	});

	it('rejects an unknown kind, a bad config, and a duplicate name (422)', async () => {
		const pid = await createProject();
		await expectError(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 'nope',
				name: 'x',
				config: {},
			}),
			422,
		);
		await expectError(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 'postgres',
				name: 'x',
				config: { host: 'h' }, // intentionally missing required fields
			}),
			422,
		);
		await createPg(pid);
		await expectError(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 'postgres',
				name: 'prod',
				config: PG_CONFIG,
			}),
			422,
		);
	});

	it('delete removes the instance and its history; idempotent', async () => {
		const pid = await createProject();
		const created = await createPg(pid);
		await expectOk(await request('DELETE', `/projects/${pid}/integrations/${created.id}`));
		await expectOk(await request('DELETE', `/projects/${pid}/integrations/${created.id}`));
		expect(
			await expectOk<unknown[]>(await request('GET', `/projects/${pid}/integrations`)),
		).toEqual([]);
		await expectError(await request('GET', `/projects/${pid}/integrations/${created.id}`), 404);
	});

	it('list requires membership; create/update/delete/test require admin', async () => {
		const pid = await createProject();
		const editor = uid('user_editor');
		await expectOk(
			await request('POST', `/projects/${pid}/members`, { user_id: editor, role: 'editor' }),
			201,
		);
		const created = await createPg(pid);

		const editorReq = createTestApi({
			bucket,
			userId: editor,
			deps: integrationsDeps(bucket),
		}).request;
		const strangerReq = createTestApi({
			bucket,
			userId: uid('user_stranger'),
			deps: integrationsDeps(bucket),
		}).request;

		await expectError(await strangerReq('GET', `/projects/${pid}/integrations`), 403);
		await expectError(await strangerReq('GET', `/projects/${pid}/integrations/${created.id}`), 403);
		await expectError(
			await strangerReq('GET', `/projects/${pid}/integrations/${created.id}/versions`),
			403,
		);
		await expectOk(await editorReq('GET', `/projects/${pid}/integrations`));
		await expectOk(await editorReq('GET', `/projects/${pid}/integrations/${created.id}`));
		await expectOk(await editorReq('GET', `/projects/${pid}/integrations/${created.id}/versions`));
		await expectError(
			await editorReq('POST', `/projects/${pid}/integrations`, {
				kind: 'postgres',
				name: 'nope',
				config: PG_CONFIG,
			}),
			403,
		);
		await expectError(
			await editorReq('PATCH', `/projects/${pid}/integrations/${created.id}`, { enabled: false }),
			403,
		);
		await expectError(
			await editorReq('DELETE', `/projects/${pid}/integrations/${created.id}`),
			403,
		);
		await expectError(
			await editorReq('POST', `/projects/${pid}/integrations/test`, { id: created.id }),
			403,
		);
	});

	it('a super admin holds admin on a project they are not a member of', async () => {
		const pid = await createProject();
		const god = uid('user_god');
		const godReq = createTestApi({
			bucket,
			userId: god,
			deps: { ...integrationsDeps(bucket), policy: { superAdmins: [god] } },
		}).request;

		const created = await expectOk<{ id: string }>(
			await godReq('POST', `/projects/${pid}/integrations`, {
				kind: 'postgres',
				name: 'god-made',
				config: PG_CONFIG,
			}),
			201,
		);
		await expectOk(await godReq('GET', `/projects/${pid}/integrations`));
		await expectOk(await godReq('GET', `/projects/${pid}/integrations/${created.id}`));
		await expectOk(await godReq('GET', `/projects/${pid}/integrations/${created.id}/versions`));
		await expectOk(
			await godReq('PATCH', `/projects/${pid}/integrations/${created.id}`, { enabled: false }),
		);
		await expectOk(await godReq('DELETE', `/projects/${pid}/integrations/${created.id}`));
	});

	it('404s every route once the project is soft-deleted — owner and super admin alike', async () => {
		const pid = await createProject();
		const created = await createPg(pid);
		await expectOk(await request('DELETE', `/projects/${pid}`));

		const god = uid('user_god');
		for (const req of [
			request,
			createTestApi({
				bucket,
				userId: god,
				deps: { ...integrationsDeps(bucket), policy: { superAdmins: [god] } },
			}).request,
		]) {
			await expectError(await req('GET', `/projects/${pid}/integrations`), 404);
			await expectError(await req('GET', `/projects/${pid}/integrations/${created.id}`), 404);
			await expectError(
				await req('GET', `/projects/${pid}/integrations/${created.id}/versions`),
				404,
			);
			await expectError(
				await req('POST', `/projects/${pid}/integrations`, {
					kind: 'postgres',
					name: 'after',
					config: PG_CONFIG,
				}),
				404,
			);
			await expectError(
				await req('PATCH', `/projects/${pid}/integrations/${created.id}`, { enabled: false }),
				404,
			);
			await expectError(await req('DELETE', `/projects/${pid}/integrations/${created.id}`), 404);
			await expectError(
				await req('POST', `/projects/${pid}/integrations/test`, { id: created.id }),
				404,
			);
		}
	});

	it('does not resolve or probe an integration id through another project', async () => {
		const first = await createProject();
		const second = await createProject();
		const created = await createPg(first);

		await expectError(await request('GET', `/projects/${second}/integrations/${created.id}`), 404);
		await expectError(
			await request('POST', `/projects/${second}/integrations/test`, { id: created.id }),
			404,
		);
		expect(
			await expectOk<unknown[]>(await request('GET', `/projects/${second}/integrations`)),
		).toEqual([]);
	});

	it('404s everywhere when the deployment has integrations disabled', async () => {
		const bare = createTestApi({ bucket, userId: ACTOR }).request;
		await expectError(await bare('GET', '/integrations/kinds'), 404);
		const pid = await createProject();
		const iid = 'intg-0000000000000000';
		await expectError(await bare('GET', `/projects/${pid}/integrations`), 404);
		await expectError(
			await bare('POST', `/projects/${pid}/integrations`, {
				kind: 'postgres',
				name: 'prod',
				config: PG_CONFIG,
			}),
			404,
		);
		await expectError(await bare('GET', `/projects/${pid}/integrations/${iid}`), 404);
		await expectError(
			await bare('PATCH', `/projects/${pid}/integrations/${iid}`, { enabled: false }),
			404,
		);
		await expectError(await bare('DELETE', `/projects/${pid}/integrations/${iid}`), 404);
		await expectError(await bare('GET', `/projects/${pid}/integrations/${iid}/versions`), 404);
		await expectError(
			await bare('POST', `/projects/${pid}/integrations/test`, {
				kind: 'postgres',
				config: PG_CONFIG,
			}),
			404,
		);
	});

	it('capabilities reflects whether integrations are wired', async () => {
		const withIt = await expectOk<{ integrations: { available: boolean } }>(
			await request('GET', '/capabilities'),
		);
		expect(withIt.integrations.available).toBe(true);
		const without = createTestApi({ bucket, userId: ACTOR }).request;
		const caps = await expectOk<{ integrations: { available: boolean } }>(
			await without('GET', '/capabilities'),
		);
		expect(caps.integrations.available).toBe(false);
	});

	it('test on a kind without a probe explains itself (422)', async () => {
		const pid = await createProject();
		await expectError(
			await request('POST', `/projects/${pid}/integrations/test`, {
				kind: 'postgres',
				config: PG_CONFIG,
			}),
			422,
		);
	});

	it('rate-limits connection tests per USER (429 after the budget)', async () => {
		const pid = await createProject();
		// A dedicated user so this test cannot eat other tests' budget (the
		// limiter is per-user within the process).
		const rateUser = uid('user_rate');
		await expectOk(
			await request('POST', `/projects/${pid}/members`, { user_id: rateUser, role: 'admin' }),
			201,
		);
		const rateReq = createTestApi({
			bucket,
			userId: rateUser,
			deps: integrationsDeps(bucket),
		}).request;

		const probeOnce = () =>
			rateReq('POST', `/projects/${pid}/integrations/test`, {
				kind: 'postgres',
				config: PG_CONFIG,
			});
		// Each attempt consumes budget even when the kind cannot be tested (422).
		for (let i = 0; i < 10; i++) {
			await expectError(await probeOnce(), 422);
		}
		await expectError(await probeOnce(), 429);
	});

	it('one user exhausting the probe budget does not throttle another user', async () => {
		const pid = await createProject();
		const first = uid('user_rate_isolated_first');
		const second = uid('user_rate_isolated_second');
		for (const user_id of [first, second]) {
			await expectOk(
				await request('POST', `/projects/${pid}/members`, { user_id, role: 'admin' }),
				201,
			);
		}
		const firstReq = createTestApi({
			bucket,
			userId: first,
			deps: integrationsDeps(bucket),
		}).request;
		const secondReq = createTestApi({
			bucket,
			userId: second,
			deps: integrationsDeps(bucket),
		}).request;
		const body = { kind: 'postgres', config: PG_CONFIG };

		for (let i = 0; i < 10; i++) {
			await expectError(await firstReq('POST', `/projects/${pid}/integrations/test`, body), 422);
		}
		await expectError(await firstReq('POST', `/projects/${pid}/integrations/test`, body), 429);
		await expectError(await secondReq('POST', `/projects/${pid}/integrations/test`, body), 422);
	});
});
