import { describe, it, expect, beforeEach } from 'vitest';
import { ValidationError } from '../../errors';
import { createProjectId } from '../../ids';
import type { ProjectId } from '../../ids';
import type { ManagedSecretCodec, SecretResolver } from '../../ports/secrets';
import { ACTOR, MemoryBucket } from '../../testing';
import { ProjectSecretsStore } from './ProjectSecretsStore';

/** A resolver that echoes a fixed map keyed by locator. */
function stubResolver(map: Record<string, string> = {}): SecretResolver {
	return {
		backend: 'stub',
		resolve: async (ref) => {
			if (!(ref.locator in map)) throw new Error(`stub: no value for ${ref.locator}`);
			return map[ref.locator];
		},
	};
}

/** A reversible "codec" — enough to prove managed dispatch without real crypto. */
const fakeCodec: ManagedSecretCodec = {
	encrypt: async (plaintext, ctx) => ({
		kek_id: 'test',
		alg: 'A256GCM',
		iv: 'aXY=',
		ciphertext: btoa(`${ctx.path}:${plaintext}`),
	}),
	decrypt: async (envelope) => atob(envelope.ciphertext).split(':').slice(1).join(':'),
};

describe('ProjectSecretsStore', () => {
	let bucket: MemoryBucket;
	let pid: ProjectId;

	beforeEach(() => {
		bucket = new MemoryBucket();
		pid = createProjectId();
	});

	it('put(reference) then list returns name + locator, no value key', async () => {
		const store = new ProjectSecretsStore({ bucket, resolvers: [stubResolver()] });
		await store.put(
			pid,
			'OPENAI_API_KEY',
			{
				kind: 'reference',
				ref: { backend: 'stub', locator: 'prod/ai#OPENAI_API_KEY' },
			},
			ACTOR,
		);

		const list = await store.list(pid);
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({
			name: 'OPENAI_API_KEY',
			kind: 'reference',
			ref: { backend: 'stub', locator: 'prod/ai#OPENAI_API_KEY' },
		});
		expect(JSON.stringify(list)).not.toContain('value');
	});

	it('resolve returns the resolver plaintext', async () => {
		const store = new ProjectSecretsStore({
			bucket,
			resolvers: [stubResolver({ 'prod/ai': 'sk-live-123' })],
		});
		await store.put(
			pid,
			'OPENAI_API_KEY',
			{
				kind: 'reference',
				ref: { backend: 'stub', locator: 'prod/ai' },
			},
			ACTOR,
		);

		expect(await store.resolve(pid)).toEqual({ OPENAI_API_KEY: 'sk-live-123' });
	});

	it('overwrite preserves created_at + created_by, bumps updated_at', async () => {
		let clock = 0;
		const store = new ProjectSecretsStore({
			bucket,
			resolvers: [stubResolver()],
			now: () => new Date(1_700_000_000_000 + clock++ * 1000).toISOString(),
		});
		const first = await store.put(
			pid,
			'K',
			{
				kind: 'reference',
				ref: { backend: 'stub', locator: 'a' },
			},
			ACTOR,
		);
		const second = await store.put(
			pid,
			'K',
			{
				kind: 'reference',
				ref: { backend: 'stub', locator: 'b' },
			},
			ACTOR,
		);

		expect(second.created_at).toBe(first.created_at);
		expect(second.created_by).toBe(first.created_by);
		expect(second.updated_at).not.toBe(first.updated_at);
		expect(second.ref?.locator).toBe('b');
	});

	it('delete is idempotent', async () => {
		const store = new ProjectSecretsStore({ bucket, resolvers: [stubResolver()] });
		await store.put(pid, 'K', { kind: 'reference', ref: { backend: 'stub', locator: 'a' } }, ACTOR);
		await store.delete(pid, 'K');
		await expect(store.delete(pid, 'K')).resolves.toBeUndefined();
		expect(await store.list(pid)).toEqual([]);
	});

	it('put(reference) with an unregistered backend throws', async () => {
		const store = new ProjectSecretsStore({ bucket, resolvers: [stubResolver()] });
		await expect(
			store.put(pid, 'K', { kind: 'reference', ref: { backend: 'nope', locator: 'a' } }, ACTOR),
		).rejects.toThrow(ValidationError);
	});

	it('resolve throws (naming the entry) when a stored backend has no resolver', async () => {
		// Write with the backend registered, then rebuild the store without it.
		const withResolver = new ProjectSecretsStore({ bucket, resolvers: [stubResolver()] });
		await withResolver.put(
			pid,
			'ORPHAN',
			{
				kind: 'reference',
				ref: { backend: 'stub', locator: 'a' },
			},
			ACTOR,
		);

		const withoutResolver = new ProjectSecretsStore({ bucket, resolvers: [] });
		await expect(withoutResolver.resolve(pid)).rejects.toThrow(/ORPHAN/);
	});

	it('put(managed) throws when no codec is configured', async () => {
		const store = new ProjectSecretsStore({ bucket, resolvers: [stubResolver()] });
		await expect(store.put(pid, 'K', { kind: 'managed', value: 'secret' }, ACTOR)).rejects.toThrow(
			ValidationError,
		);
	});

	it('fans a JSON secret out into one env var per key, with a prefix', async () => {
		const store = new ProjectSecretsStore({
			bucket,
			resolvers: [stubResolver({ bundle: JSON.stringify({ API_KEY: 'a', DB_URL: 'b' }) })],
		});
		await store.put(
			pid,
			'APP',
			{
				kind: 'reference',
				ref: { backend: 'stub', locator: 'bundle', expand: 'json', prefix: 'APP_' },
			},
			ACTOR,
		);

		expect(await store.resolve(pid)).toEqual({ APP_API_KEY: 'a', APP_DB_URL: 'b' });
		// The metadata surfaces expand/prefix so the UI can show the fan-out.
		expect((await store.list(pid))[0].ref).toMatchObject({ expand: 'json', prefix: 'APP_' });
	});

	it('fails closed when an expand payload is not a JSON object', async () => {
		const store = new ProjectSecretsStore({
			bucket,
			resolvers: [stubResolver({ bad: 'not json' })],
		});
		await store.put(
			pid,
			'APP',
			{ kind: 'reference', ref: { backend: 'stub', locator: 'bad', expand: 'json' } },
			ACTOR,
		);
		await expect(store.resolve(pid)).rejects.toThrow(/APP/);
	});

	it('fails closed when an expanded key is not a valid env var name', async () => {
		const store = new ProjectSecretsStore({
			bucket,
			resolvers: [stubResolver({ bundle: JSON.stringify({ 'not-valid': 'x' }) })],
		});
		await store.put(
			pid,
			'APP',
			{ kind: 'reference', ref: { backend: 'stub', locator: 'bundle', expand: 'json' } },
			ACTOR,
		);
		await expect(store.resolve(pid)).rejects.toThrow(ValidationError);
	});

	it('throws on a name collision between two entries', async () => {
		const store = new ProjectSecretsStore({
			bucket,
			resolvers: [stubResolver({ a: JSON.stringify({ SHARED: '1' }), b: 'plain' })],
		});
		await store.put(
			pid,
			'GROUP',
			{ kind: 'reference', ref: { backend: 'stub', locator: 'a', expand: 'json' } },
			ACTOR,
		);
		await store.put(
			pid,
			'SHARED',
			{ kind: 'reference', ref: { backend: 'stub', locator: 'b' } },
			ACTOR,
		);
		await expect(store.resolve(pid)).rejects.toThrow(/collision/);
	});

	it('validate resolves a reference without persisting it; throws on a bad backend', async () => {
		const store = new ProjectSecretsStore({ bucket, resolvers: [stubResolver({ x: 'v' })] });
		await expect(
			store.validate({ kind: 'reference', ref: { backend: 'stub', locator: 'x' } }),
		).resolves.toBeUndefined();
		await expect(
			store.validate({ kind: 'reference', ref: { backend: 'nope', locator: 'x' } }),
		).rejects.toThrow(ValidationError);
		expect(await store.list(pid)).toEqual([]); // nothing was written
	});

	it('validate checks an expand payload is JSON', async () => {
		const store = new ProjectSecretsStore({ bucket, resolvers: [stubResolver({ bad: 'nope' })] });
		await expect(
			store.validate({
				kind: 'reference',
				ref: { backend: 'stub', locator: 'bad', expand: 'json' },
			}),
		).rejects.toThrow(ValidationError);
	});

	it('managed entries round-trip through the codec and never expose the value in list', async () => {
		const store = new ProjectSecretsStore({ bucket, managed: fakeCodec });
		await store.put(pid, 'DB_PASSWORD', { kind: 'managed', value: 'hunter2' }, ACTOR);

		const list = await store.list(pid);
		expect(list[0]).toMatchObject({ name: 'DB_PASSWORD', kind: 'managed' });
		expect(list[0].ref).toBeUndefined();
		expect(JSON.stringify(list)).not.toContain('hunter2');

		expect(await store.resolve(pid)).toEqual({ DB_PASSWORD: 'hunter2' });
	});
});
