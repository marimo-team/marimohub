import { describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { UnavailableError } from '@marimo-hub/core/errors';
import { makeHubStorage, metadataPostgresUrl } from './metadata';
import type { MetadataFactory } from './metadata';

const marker = {
	version: 1,
	artifact_store_id: '11111111-1111-4111-8111-111111111111',
	backend: 'postgres',
	epoch: 2,
	state: 'active',
	namespace: 'test',
	transfer_id: null,
};
const env = {
	MARIMOHUB_METADATA_BACKEND: 'postgres',
	MARIMOHUB_METADATA_NAMESPACE: 'test',
	MARIMOHUB_METADATA_POSTGRES_URL: 'postgres://example.invalid/hub?sslmode=verify-full',
};
function factory() {
	const data = new MemoryBucket();
	const runtime = Object.assign(data, {
		ready: vi.fn(async () => {}),
		close: vi.fn(async () => {}),
		sessions: { list: vi.fn(async () => ({ records: [] })) },
	});
	return { runtime, create: vi.fn<MetadataFactory>(() => runtime) };
}

describe('metadata composition', () => {
	it('keeps legacy bucket identity while checking backend markers at startup', async () => {
		const bucket = new MemoryBucket();
		const storage = makeHubStorage(bucket, {});
		expect(storage.logicalBucket).toBe(bucket);
		await storage.ready();
		await bucket.put('_system/metadata-backend.json', JSON.stringify(marker));
		await expect(storage.ready()).rejects.toThrow('incompatible');
	});
	it('rejects unsupported hosts, missing fields and conflicting bucket configuration', () => {
		const bucket = new MemoryBucket();
		expect(() => makeHubStorage(bucket, env)).toThrow('Node');
		expect(() =>
			makeHubStorage(bucket, { ...env, MARIMOHUB_METADATA_POSTGRES_URL: undefined }),
		).toThrow('MARIMOHUB_METADATA_POSTGRES_URL');
		expect(() => makeHubStorage(bucket, { ...env, MARIMOHUB_METADATA_BACKEND: 'bucket' })).toThrow(
			'require',
		);
		expect(() =>
			makeHubStorage(bucket, { ...env, MARIMOHUB_METADATA_POSTGRES_POOL_MAX: '1.5' }),
		).toThrow('positive');
		expect(() =>
			makeHubStorage(bucket, { ...env, MARIMOHUB_METADATA_NAMESPACE: '龍'.repeat(43) }),
		).toThrow('128');
	});
	it('refuses initialization without a matching active marker', async () => {
		const bucket = new MemoryBucket();
		const { create } = factory();
		const storage = makeHubStorage(bucket, env, create);
		await expect(storage.ready()).rejects.toThrow('marker');
		await bucket.put(
			'_system/metadata-backend.json',
			JSON.stringify({ ...marker, state: 'frozen' }),
		);
		await expect(storage.ready()).rejects.toThrow('marker');
		expect(create).not.toHaveBeenCalled();
	});
	it('routes only after readiness and closes the runtime', async () => {
		const bucket = new MemoryBucket();
		const { create, runtime } = factory();
		const storage = makeHubStorage(bucket, env, create);
		const early = storage.logicalBucket.get('_system/catalog.json');
		await expect(early).rejects.toBeInstanceOf(UnavailableError);
		await expect(early).rejects.toThrow('not ready');
		await bucket.put('_system/metadata-backend.json', JSON.stringify(marker));
		await Promise.all([storage.ready(), storage.ready()]);
		expect(runtime.ready).toHaveBeenCalledOnce();
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({ epoch: 2, artifactStoreId: marker.artifact_store_id }),
		);
		await storage.logicalBucket.put('_system/catalog.json', 'metadata');
		expect(await bucket.get('_system/catalog.json')).toBeNull();
		expect(await (await runtime.get('_system/catalog.json'))!.text()).toBe('metadata');
		await storage.close();
		expect(runtime.close).toHaveBeenCalledOnce();
		await expect(storage.logicalBucket.get('_system/catalog.json')).rejects.toBeInstanceOf(
			UnavailableError,
		);
		await expect(storage.sessions!.list({ limit: 1 })).rejects.toBeInstanceOf(UnavailableError);
		await expect(storage.transactions!.run(['a'], async () => {})).rejects.toBeInstanceOf(
			UnavailableError,
		);
	});
	it('rejects artifact keys on the direct metadata store', async () => {
		const bucket = new MemoryBucket();
		await bucket.put('_system/metadata-backend.json', JSON.stringify(marker));
		const { create, runtime } = factory();
		const storage = makeHubStorage(bucket, env, create);
		await storage.ready();
		const artifact = 'projects/p/notebooks/n/workspace/data.json';
		await expect(storage.metadata.put(artifact, 'x')).rejects.toThrow('metadata key');
		await expect(storage.metadata.get(artifact)).rejects.toThrow('metadata key');
		await expect(storage.metadata.head(artifact)).rejects.toThrow('metadata key');
		await expect(storage.metadata.delete(['_system/catalog.json', artifact])).rejects.toThrow(
			'metadata key',
		);
		await expect(storage.metadata.put('_system/metadata-backend.json', '{}')).rejects.toThrow(
			'metadata key',
		);
		expect(await runtime.get(artifact)).toBeNull();
		await storage.metadata.put('_system/catalog.json', '{}');
		expect(await runtime.get('_system/catalog.json')).not.toBeNull();
		await storage.close();
	});
	it.each([
		'postgres://user:secret@localhost/hub',
		'postgres://127.0.0.1:5432/hub',
		'postgres://[::1]/hub',
		'postgres:///hub?host=/var/run/postgresql',
		'postgres://%2Fvar%2Frun%2Fpostgresql/hub',
		'postgres://db.example.com/hub?sslmode=verify-full',
		'postgres://db.example.com/hub?sslmode=verify-ca',
	])('accepts local or verified PostgreSQL transport %s', (url) => {
		expect(
			metadataPostgresUrl(
				{ MARIMOHUB_METADATA_POSTGRES_URL: url },
				'MARIMOHUB_METADATA_POSTGRES_URL',
			),
		).toBe(url);
	});
	it.each([
		'postgres://user:secret@db.example.com/hub',
		'postgres://db.example.com/hub?sslmode=require',
		'postgres://localhost/hub?host=db.example.com&sslmode=prefer',
	])('rejects unverified remote PostgreSQL transport %s', (url) => {
		const variable = 'MARIMOHUB_METADATA_ADMIN_POSTGRES_URL';
		expect(() => metadataPostgresUrl({ [variable]: url }, variable)).toThrow(variable);
		expect(() => metadataPostgresUrl({ [variable]: url }, variable)).not.toThrow('secret');
		expect(
			metadataPostgresUrl(
				{ [variable]: url, MARIMOHUB_METADATA_POSTGRES_ALLOW_INSECURE_TRANSPORT: 'true' },
				variable,
			),
		).toBe(url);
		expect(() =>
			makeHubStorage(new MemoryBucket(), { ...env, MARIMOHUB_METADATA_POSTGRES_URL: url }, vi.fn()),
		).toThrow('MARIMOHUB_METADATA_POSTGRES_URL');
	});
	it('disposes failed initialization and retries with a new runtime', async () => {
		const bucket = new MemoryBucket();
		await bucket.put('_system/metadata-backend.json', JSON.stringify(marker));
		const first = factory().runtime;
		first.ready.mockRejectedValueOnce(new Error('connection unavailable'));
		const next = factory().runtime;
		const create = vi.fn<MetadataFactory>().mockReturnValueOnce(first).mockReturnValueOnce(next);
		const storage = makeHubStorage(bucket, env, create);
		await expect(storage.ready()).rejects.toThrow('connection unavailable');
		expect(first.close).toHaveBeenCalledOnce();
		await expect(storage.metadata.get('_system/catalog.json')).rejects.toThrow('not ready');
		await storage.ready();
		await storage.close();
		expect(next.close).toHaveBeenCalledOnce();
	});

	it('coalesces close calls during initialization and never reopens a closed store', async () => {
		const bucket = new MemoryBucket();
		await bucket.put('_system/metadata-backend.json', JSON.stringify(marker));
		const { create, runtime } = factory();
		const gate = Promise.withResolvers<void>();
		runtime.ready.mockImplementation(() => gate.promise);
		const storage = makeHubStorage(bucket, env, create);
		const ready = storage.ready();
		void ready.catch(() => {});
		await vi.waitFor(() => expect(runtime.ready).toHaveBeenCalledOnce());
		const close1 = storage.close();
		const close2 = storage.close();
		expect(runtime.close).not.toHaveBeenCalled();
		gate.resolve();
		await Promise.all([close1, close2]);
		await expect(ready).rejects.toThrow('closed');
		expect(runtime.close).toHaveBeenCalledOnce();
		await expect(storage.ready()).rejects.toThrow('closed');
	});

	it.each([
		{ namespace: 'other' },
		{ backend: 'bucket', namespace: null },
		{ state: 'retired' },
		{ epoch: 0 },
		{ artifact_store_id: 'invalid' },
	])('rejects an incompatible or malformed marker %j', async (change) => {
		const bucket = new MemoryBucket();
		await bucket.put('_system/metadata-backend.json', JSON.stringify({ ...marker, ...change }));
		const { create } = factory();
		await expect(makeHubStorage(bucket, env, create).ready()).rejects.toThrow();
		expect(create).not.toHaveBeenCalled();
	});
});
