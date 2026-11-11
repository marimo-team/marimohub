import { afterEach, expect, it, vi } from 'vitest';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { ACTOR } from '@marimo-hub/core/testing';
import { createAppSessionFixture } from '../testing/appSession';
import { expectError, expectOk } from '../testing';

afterEach(() => vi.restoreAllMocks());

async function fixture() {
	const f = await createAppSessionFixture(new MemoryBucket());
	const starting = { ...f.session, status: 'starting' as const };
	await f.bucket.put(f.sessionKey, JSON.stringify(starting));
	const path = `/projects/${f.project.id}/notebooks/${f.notebook.id}/sessions/${f.session.session_id}`;
	return { ...f, starting, path };
}

it('waits only for starting sessions and bounds the query parameter', async () => {
	const f = await fixture();
	const wait = vi
		.spyOn(f.client.deps.services.sessions, 'waitForStartup')
		.mockResolvedValue(f.starting);
	await expectOk(await f.client.request('GET', `${f.path}?wait=20`));
	expect(wait).toHaveBeenCalledWith(
		expect.objectContaining({ status: 'starting' }),
		20_000,
		expect.any(AbortSignal),
	);
	await expectError(await f.client.request('GET', `${f.path}?wait=21`), 422);
	await expectError(await f.client.request('GET', `${f.path}?wait=-1`), 422);
	await f.bucket.put(f.sessionKey, JSON.stringify(f.session));
	wait.mockClear();
	await expectOk(await f.client.request('GET', `${f.path}?wait=20`));
	expect(wait).not.toHaveBeenCalled();
});

it('rechecks authorization after the wait before returning session details', async () => {
	const f = await fixture();
	vi.spyOn(f.client.deps.services.sessions, 'waitForStartup').mockImplementation(async () => {
		await f.services.projects.deleteProject(f.project.id, ACTOR);
		return f.starting;
	});
	await expectError(await f.client.request('GET', `${f.path}?wait=20`), 404);
});
