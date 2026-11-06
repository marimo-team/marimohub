import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createProjectId } from '../../ids';
import type { IntegrationId, ProjectId } from '../../ids';
import { paths } from '../../paths';
import { ACTOR } from '../../testing/fixtures';
import { MemoryBucket } from '../../testing/MemoryBucket';
import { OrgIntegrationsStore, ProjectIntegrationsStore } from './ProjectIntegrationsStore';
import { IntegrationRegistry } from './registry';
import { defineIntegration } from './sdk';

const switchKind = defineIntegration({
	kind: 'switch',
	title: 'Switch',
	description: 'test kind with an ambient_env switch',
	category: 'other',
	brand: { color: '#000000' },
	schemaVersion: 1,
	configSchema: z.object({ host: z.string(), ambient_env: z.boolean().default(true) }),
	render: () => ({ env: {}, files: [] }),
});

const plainKind = defineIntegration({
	kind: 'plain',
	title: 'Plain',
	description: 'test kind without an ambient_env switch',
	category: 'other',
	brand: { color: '#000000' },
	schemaVersion: 1,
	configSchema: z.object({ host: z.string() }),
	render: () => ({ env: {}, files: [] }),
});

describe('integration list ambient_env denormalisation', () => {
	let bucket: MemoryBucket;
	let project: ProjectIntegrationsStore;
	let org: OrgIntegrationsStore;
	let pid: ProjectId;
	let versionReads: string[];
	let afterGet: (key: string) => Promise<void>;

	const headKey = (id: IntegrationId) => paths.project(pid).integration(id).head;

	async function readHead(id: IntegrationId): Promise<Record<string, unknown>> {
		const body = await bucket.get(headKey(id));
		return JSON.parse(await body!.text()) as Record<string, unknown>;
	}

	async function stripHeadField(id: IntegrationId): Promise<void> {
		const { ambient_env: _, ...legacy } = await readHead(id);
		await bucket.put(headKey(id), JSON.stringify(legacy));
	}

	beforeEach(() => {
		bucket = new MemoryBucket();
		const registry = new IntegrationRegistry();
		registry.register(switchKind);
		registry.register(plainKind);
		project = new ProjectIntegrationsStore({ bucket, registry });
		org = new OrgIntegrationsStore({ bucket, registry });
		pid = createProjectId();
		versionReads = [];
		afterGet = async () => {};
		const get = bucket.get.bind(bucket);
		vi.spyOn(bucket, 'get').mockImplementation(async (key: string) => {
			if (key.includes('/versions/')) versionReads.push(key);
			const body = await get(key);
			await afterGet(key);
			return body;
		});
	});

	it('lists created integrations from their heads alone', async () => {
		const on = await project.create(
			pid,
			{ kind: 'switch', name: 'on', config: { host: 'a' } },
			ACTOR,
		);
		await project.create(pid, { kind: 'plain', name: 'plain', config: { host: 'b' } }, ACTOR);
		await org.create(
			{ kind: 'switch', name: 'shared', config: { host: 'c', ambient_env: false } },
			ACTOR,
		);
		versionReads = [];

		const entries = await project.list(pid);

		expect(entries.map(({ name, ambient_env }) => ({ name, ambient_env }))).toEqual([
			{ name: 'on', ambient_env: true },
			{ name: 'plain', ambient_env: undefined },
			{ name: 'shared', ambient_env: false },
		]);
		expect(versionReads).toEqual([]);
		expect(await readHead(on.id)).toMatchObject({ ambient_env: true });
	});

	it('backfills a legacy head on the first list so the next list reads no version', async () => {
		const created = await project.create(
			pid,
			{ kind: 'switch', name: 'legacy', config: { host: 'a', ambient_env: false } },
			ACTOR,
		);
		await stripHeadField(created.id);
		const before = await readHead(created.id);
		versionReads = [];

		expect((await project.list(pid))[0]?.ambient_env).toBe(false);
		expect(versionReads).toHaveLength(1);
		expect(await readHead(created.id)).toEqual({ ...before, ambient_env: false });

		versionReads = [];
		expect((await project.list(pid))[0]?.ambient_env).toBe(false);
		expect(versionReads).toEqual([]);
	});

	it('moves the head field with each config update', async () => {
		const created = await project.create(
			pid,
			{ kind: 'switch', name: 'toggle', config: { host: 'a' } },
			ACTOR,
		);

		await project.update(pid, created.id, { config: { host: 'a', ambient_env: false } }, ACTOR);
		expect(await readHead(created.id)).toMatchObject({ current_version: 2, ambient_env: false });
		versionReads = [];
		expect((await project.list(pid))[0]?.ambient_env).toBe(false);
		expect(versionReads).toEqual([]);

		await project.update(pid, created.id, { config: { host: 'a', ambient_env: true } }, ACTOR);
		expect(await readHead(created.id)).toMatchObject({ current_version: 3, ambient_env: true });
		versionReads = [];
		expect((await project.list(pid))[0]?.ambient_env).toBe(true);
		expect(versionReads).toEqual([]);
	});

	it('leaves a head changed during the backfill untouched', async () => {
		const created = await project.create(
			pid,
			{ kind: 'switch', name: 'raced', config: { host: 'a', ambient_env: false } },
			ACTOR,
		);
		await stripHeadField(created.id);
		const rival = { ...(await readHead(created.id)), enabled: false };
		let raced = false;
		versionReads = [];
		afterGet = async (key) => {
			if (key !== headKey(created.id) || versionReads.length === 0 || raced) return;
			raced = true;
			await bucket.put(key, JSON.stringify(rival));
		};

		expect((await project.list(pid))[0]?.ambient_env).toBe(false);
		expect(raced).toBe(true);
		expect(await readHead(created.id)).toEqual(rival);
	});
});
