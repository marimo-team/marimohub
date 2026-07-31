import { describe, it, expect, beforeEach } from 'vitest';
import { ProjectSecretsStore } from '@marimo-hub/core';
import type { SecretResolver } from '@marimo-hub/core';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import { ACTOR, uid } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';

const stubResolver: SecretResolver = {
	backend: 'stub',
	resolve: async (ref) => `resolved:${ref.locator}`,
};

function secretsDeps(bucket: MemoryBucket) {
	return { secrets: new ProjectSecretsStore({ bucket, resolvers: [stubResolver] }) };
}

describe('Secrets routes', () => {
	let bucket: MemoryBucket;
	let request: ReturnType<typeof createTestApi>['request'];

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		request = createTestApi({ bucket, userId: ACTOR, deps: secretsDeps(bucket) }).request;
	});

	async function createProject() {
		const data = await expectOk<{ id: string }>(
			await request('POST', '/projects', { name: 'P', description: 'd' }),
			201,
		);
		return data.id;
	}

	async function addMember(pid: string, user: string, role: string) {
		await expectOk(await request('POST', `/projects/${pid}/members`, { user_id: user, role }), 201);
	}

	it('put(reference) then list shows the locator but no value key', async () => {
		const pid = await createProject();
		await expectOk(
			await request('PUT', `/projects/${pid}/secrets/OPENAI_API_KEY`, {
				kind: 'reference',
				backend: 'stub',
				locator: 'prod/ai#OPENAI_API_KEY',
			}),
		);

		const list = await expectOk<any[]>(await request('GET', `/projects/${pid}/secrets`));
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({
			name: 'OPENAI_API_KEY',
			kind: 'reference',
			ref: { backend: 'stub', locator: 'prod/ai#OPENAI_API_KEY' },
		});
		expect(JSON.stringify(list)).not.toContain('value');
	});

	it('stores a managed secret without ever returning or auditing its value', async () => {
		const pid = await createProject();
		const SECRET_VALUE = 'sk-super-secret-managed-value';

		// A managed codec (encrypted-in-bucket) so `kind: 'managed'` is accepted.
		const codec = {
			encrypt: async (plaintext: string) => ({
				kek_id: 'test',
				alg: 'A256GCM' as const,
				iv: 'aXY=',
				ciphertext: Buffer.from(plaintext).toString('base64'),
			}),
			decrypt: async (env: { ciphertext: string }) =>
				Buffer.from(env.ciphertext, 'base64').toString('utf8'),
		};
		const managedReq = createTestApi({
			bucket,
			userId: ACTOR,
			deps: {
				secrets: new ProjectSecretsStore({ bucket, resolvers: [stubResolver], managed: codec }),
			},
		}).request;

		const put = await expectOk<Record<string, unknown>>(
			await managedReq('PUT', `/projects/${pid}/secrets/MANAGED_KEY`, {
				kind: 'managed',
				value: SECRET_VALUE,
			}),
		);
		// The PUT response is metadata only — never the value.
		expect(put).toMatchObject({ name: 'MANAGED_KEY', kind: 'managed' });
		expect(JSON.stringify(put)).not.toContain(SECRET_VALUE);

		// Neither does the list.
		const list = await expectOk<any[]>(await request('GET', `/projects/${pid}/secrets`));
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({ name: 'MANAGED_KEY', kind: 'managed' });
		expect(JSON.stringify(list)).not.toContain(SECRET_VALUE);

		// Nor the audit trail.
		const events = await expectOk<any[]>(await request('GET', `/projects/${pid}/events`));
		expect(events.map((e) => e.event)).toContain('secret.put');
		expect(JSON.stringify(events)).not.toContain(SECRET_VALUE);
	});

	it('rejects an unknown backend (422) and a bad name (422)', async () => {
		const pid = await createProject();
		await expectError(
			await request('PUT', `/projects/${pid}/secrets/OPENAI_API_KEY`, {
				kind: 'reference',
				backend: 'nope',
				locator: 'x',
			}),
			422,
		);
		await expectError(
			await request('PUT', `/projects/${pid}/secrets/lower-case`, {
				kind: 'reference',
				backend: 'stub',
				locator: 'x',
			}),
			422,
		);
	});

	it('delete removes the entry', async () => {
		const pid = await createProject();
		await expectOk(
			await request('PUT', `/projects/${pid}/secrets/K`, {
				kind: 'reference',
				backend: 'stub',
				locator: 'x',
			}),
		);
		await expectOk(await request('DELETE', `/projects/${pid}/secrets/K`));
		expect(await expectOk<any[]>(await request('GET', `/projects/${pid}/secrets`))).toEqual([]);
	});

	it('list requires membership; put/delete require admin', async () => {
		const pid = await createProject();
		const editor = uid('user_editor');
		const nonmember = uid('user_stranger');
		await addMember(pid, editor, 'editor');

		const editorReq = createTestApi({ bucket, userId: editor, deps: secretsDeps(bucket) }).request;
		const strangerReq = createTestApi({
			bucket,
			userId: nonmember,
			deps: secretsDeps(bucket),
		}).request;

		// A non-member cannot list (no default role → 403).
		await expectError(await strangerReq('GET', `/projects/${pid}/secrets`), 403);
		// Unless they are a super admin — then they hold admin (list + write).
		const godReq = createTestApi({
			bucket,
			userId: nonmember,
			deps: { ...secretsDeps(bucket), policy: { superAdmins: [nonmember] } },
		}).request;
		await expectOk(await godReq('GET', `/projects/${pid}/secrets`));
		await expectOk(
			await godReq('PUT', `/projects/${pid}/secrets/G`, {
				kind: 'reference',
				backend: 'stub',
				locator: 'x',
			}),
		);
		// An editor can list but not write.
		await expectOk(await editorReq('GET', `/projects/${pid}/secrets`));
		await expectError(
			await editorReq('PUT', `/projects/${pid}/secrets/K`, {
				kind: 'reference',
				backend: 'stub',
				locator: 'x',
			}),
			403,
		);
		await expectError(await editorReq('DELETE', `/projects/${pid}/secrets/K`), 403);
	});

	it('stores expand/prefix and returns them in the list', async () => {
		const pid = await createProject();
		await expectOk(
			await request('PUT', `/projects/${pid}/secrets/APP`, {
				kind: 'reference',
				backend: 'stub',
				locator: 'bundle',
				expand: 'json',
				prefix: 'APP_',
			}),
		);
		const list = await expectOk<any[]>(await request('GET', `/projects/${pid}/secrets`));
		expect(list[0].ref).toMatchObject({ expand: 'json', prefix: 'APP_' });
	});

	it('validate returns ok for a good reference and ok:false (no leak) for a bad one', async () => {
		const pid = await createProject();
		const good = await expectOk<{ ok: boolean }>(
			await request('POST', `/projects/${pid}/secrets/validate`, {
				kind: 'reference',
				backend: 'stub',
				locator: 'anything',
			}),
		);
		expect(good.ok).toBe(true);

		const bad = await expectOk<{ ok: boolean; reason?: string }>(
			await request('POST', `/projects/${pid}/secrets/validate`, {
				kind: 'reference',
				backend: 'nope',
				locator: 'x',
			}),
		);
		expect(bad.ok).toBe(false);
		expect(bad.reason).toMatch(/backend/i);
	});

	it('validate requires admin', async () => {
		const pid = await createProject();
		const editor = uid('user_editor');
		await addMember(pid, editor, 'editor');
		const editorReq = createTestApi({ bucket, userId: editor, deps: secretsDeps(bucket) }).request;
		await expectError(
			await editorReq('POST', `/projects/${pid}/secrets/validate`, {
				kind: 'reference',
				backend: 'stub',
				locator: 'x',
			}),
			403,
		);
	});

	it('records secret.put and secret.delete in the project audit log', async () => {
		const pid = await createProject();
		await expectOk(
			await request('PUT', `/projects/${pid}/secrets/K`, {
				kind: 'reference',
				backend: 'stub',
				locator: 'x',
			}),
		);
		await expectOk(await request('DELETE', `/projects/${pid}/secrets/K`));

		const events = await expectOk<any[]>(await request('GET', `/projects/${pid}/events`));
		const names = events.map((e) => e.event);
		expect(names).toContain('secret.put');
		expect(names).toContain('secret.delete');
		// The value/locator never lands in the audit trail.
		expect(JSON.stringify(events)).not.toContain('resolved:');
	});

	it('404s every route when secrets are disabled on the deployment', async () => {
		const noSecrets = createTestApi({ bucket, userId: ACTOR }).request;
		const pid = await createProject();
		await expectError(await noSecrets('GET', `/projects/${pid}/secrets`), 404);
		await expectError(
			await noSecrets('PUT', `/projects/${pid}/secrets/K`, {
				kind: 'reference',
				backend: 'stub',
				locator: 'x',
			}),
			404,
		);
	});

	it('404s every route once the project is soft-deleted — owner and super admin alike', async () => {
		const pid = await createProject();
		await expectOk(
			await request('PUT', `/projects/${pid}/secrets/K`, {
				kind: 'reference',
				backend: 'stub',
				locator: 'x',
			}),
		);
		await expectOk(await request('DELETE', `/projects/${pid}`));

		// A soft-deleted project keeps its bytes until GC, but nothing about it
		// stays reachable — its retained secret metadata must not leak, and no
		// post-delete mutation may land.
		const ref = { kind: 'reference' as const, backend: 'stub', locator: 'x' };
		for (const req of [
			request,
			createTestApi({
				bucket,
				userId: uid('user_god'),
				deps: { ...secretsDeps(bucket), policy: { superAdmins: [uid('user_god')] } },
			}).request,
		]) {
			await expectError(await req('GET', `/projects/${pid}/secrets`), 404);
			await expectError(await req('PUT', `/projects/${pid}/secrets/K`, ref), 404);
			await expectError(await req('DELETE', `/projects/${pid}/secrets/K`), 404);
			await expectError(await req('POST', `/projects/${pid}/secrets/validate`, ref), 404);
		}
	});
});
