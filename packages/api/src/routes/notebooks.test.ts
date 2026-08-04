import { describe, it, expect, beforeEach } from 'vitest';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { createNotebookId, createServices, createVersionId } from '@marimo-hub/core';
import type { ProjectId } from '@marimo-hub/core';
import { ACTOR, uid } from '@marimo-hub/core/testing';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import {
	createInitializedBucket,
	createTestApi,
	expectError,
	expectOk,
	expectPage,
} from '../testing';

describe('Notebook routes', () => {
	let bucket: MemoryBucket;
	let app: ReturnType<typeof createTestApi>['app'];
	let request: ReturnType<typeof createTestApi>['request'];
	let projectId: ProjectId;

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		const project = await createServices(bucket).projects.createProject(
			{ name: 'Test', description: 'test' },
			ACTOR,
		);
		projectId = project.id;
		const api = createTestApi({ bucket });
		app = api.app;
		request = api.request;
	});

	const nb = (path: string) => `/projects/${projectId}/notebooks${path}`;
	const encode = (s: string) => new TextEncoder().encode(s);

	function tarArchive(
		files: Record<string, string | Uint8Array<ArrayBuffer>>,
	): Uint8Array<ArrayBuffer> {
		const chunks: Uint8Array<ArrayBuffer>[] = [];
		for (const [path, value] of Object.entries(files)) {
			const body = typeof value === 'string' ? encode(value) : value;
			const header = new Uint8Array(512);
			header.set(encode(path), 0);
			header.set(encode(`${body.length.toString(8).padStart(11, '0')}\0`), 124);
			header[156] = '0'.charCodeAt(0);
			chunks.push(header, body);
			const padding = (512 - (body.length % 512)) % 512;
			if (padding > 0) chunks.push(new Uint8Array(padding));
		}
		chunks.push(new Uint8Array(1024));
		const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
		const out = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			out.set(chunk, offset);
			offset += chunk.length;
		}
		return out;
	}

	it('GET /projects/{pid}/notebooks returns empty list', async () => {
		expect(await expectPage(await request('GET', nb('')))).toEqual([]);
	});

	it('POST creates a notebook', async () => {
		const data = await expectOk<any>(
			await request('POST', nb(''), {
				title: 'Revenue',
				description: 'Monthly',
				code: 'import marimo',
			}),
			201,
		);
		expect(data.title).toBe('Revenue');
		expect(data.id).toMatch(/^nb-/);
	});

	describe('base image selection', () => {
		let req: ReturnType<typeof createTestApi>['request'];

		beforeEach(() => {
			req = createTestApi({
				bucket,
				deps: {
					sandbox: {
						bucket: { name: 'test', endpoint: '' },
						hostname: 'localhost',
						workdir: '/workspace',
						persistWorkspace: 'source',
						images: ['img-a', 'img-b'],
					},
				},
			}).request;
		});

		const create = (base_image?: string) =>
			req('POST', nb(''), { title: 'NB', description: 'D', code: 'x = 1', base_image });

		it('POST persists a listed image and normalizes "default" to no choice', async () => {
			const chosen = await expectOk<any>(await create('img-b'), 201);
			expect(chosen.base_image).toBe('img-b');

			const defaulted = await expectOk<any>(await create('default'), 201);
			expect(defaulted.base_image).toBeUndefined();
		});

		it('POST rejects an unlisted image with the valid options', async () => {
			const error = await expectError(await create('img-gone'), 400);
			expect(error.message).toContain('img-gone');
			expect(error.message).toContain('img-a');
		});

		it('POST rejects a base image when the deployment offers none', async () => {
			const res = await request('POST', nb(''), {
				title: 'NB',
				description: 'D',
				code: 'x = 1',
				base_image: 'img-a',
			});
			await expectError(res, 400);
		});

		it('PATCH sets, re-defaults, and clears the choice', async () => {
			const created = await expectOk<any>(await create(), 201);
			const path = nb(`/${created.id}`);

			const set = await expectOk<any>(await req('PATCH', path, { base_image: 'img-b' }));
			expect(set.base_image).toBe('img-b');

			const redefaulted = await expectOk<any>(await req('PATCH', path, { base_image: 'default' }));
			expect(redefaulted.base_image).toBeUndefined();

			const setAgain = await expectOk<any>(await req('PATCH', path, { base_image: 'img-a' }));
			expect(setAgain.base_image).toBe('img-a');

			const cleared = await expectOk<any>(await req('PATCH', path, { base_image: null }));
			expect(cleared.base_image).toBeUndefined();
		});

		it('PATCH rejects an unlisted image', async () => {
			const created = await expectOk<any>(await create(), 201);
			await expectError(await req('PATCH', nb(`/${created.id}`), { base_image: 'nope' }), 400);
		});

		it('an idempotent replay returns the recorded create even after the image left the list', async () => {
			const body = { title: 'NB', description: 'D', code: 'x = 1', base_image: 'img-b' };
			const headers = { 'Idempotency-Key': 'idem-base-image' };
			const first = await expectOk<any>(await req('POST', nb(''), body, headers), 201);
			expect(first.base_image).toBe('img-b');

			// Same bucket (shared idempotency records), img-b no longer offered.
			const narrowed = createTestApi({
				bucket,
				deps: {
					sandbox: {
						bucket: { name: 'test', endpoint: '' },
						hostname: 'localhost',
						workdir: '/workspace',
						persistWorkspace: 'source',
						images: ['img-a'],
					},
				},
			}).request;

			const replay = await expectOk<any>(await narrowed('POST', nb(''), body, headers), 201);
			expect(replay.id).toBe(first.id);
		});
	});

	describe('compute profile selection', () => {
		const profiles = [
			{ name: 'small', resources: { cpu: 1 } },
			{ name: 'large', resources: { cpu: 4 } },
		];

		function profileApi(override: 'none' | 'editors' = 'editors') {
			return createTestApi({
				bucket,
				deps: {
					sandbox: {
						bucket: { name: 'test', endpoint: '' },
						hostname: 'localhost',
						workdir: '/workspace',
						persistWorkspace: 'source',
						computeProfiles: profiles,
						computeProfileOverride: override,
					},
				},
			}).request;
		}

		it('persists non-default choices and exposes them in notebook lists', async () => {
			const req = profileApi();
			const chosen = await expectOk<any>(
				await req('POST', nb(''), {
					title: 'Large',
					description: 'D',
					code: 'x = 1',
					compute_profile: 'large',
				}),
				201,
			);
			expect(chosen.compute_profile).toBe('large');

			const listed = await expectPage<any>(await req('GET', nb('')));
			expect(listed.find((item) => item.id === chosen.id)?.compute_profile).toBe('large');
		});

		it('normalizes the default profile and supports set and clear', async () => {
			const req = profileApi();
			const created = await expectOk<any>(
				await req('POST', nb(''), {
					title: 'Default',
					description: 'D',
					code: 'x = 1',
					compute_profile: 'small',
				}),
				201,
			);
			expect(created.compute_profile).toBeUndefined();

			const path = nb(`/${created.id}`);
			const set = await expectOk<any>(await req('PATCH', path, { compute_profile: 'large' }));
			expect(set.compute_profile).toBe('large');
			const cleared = await expectOk<any>(await req('PATCH', path, { compute_profile: 'default' }));
			expect(cleared.compute_profile).toBeUndefined();
		});

		it('rejects unknown profiles and disabled overrides', async () => {
			const body = {
				title: 'NB',
				description: 'D',
				code: 'x = 1',
				compute_profile: 'large',
			};
			await expectError(await profileApi()('POST', nb(''), { ...body, compute_profile: 'x' }), 400);
			await expectError(await profileApi('none')('POST', nb(''), body), 400);
			await expectError(
				await profileApi('none')('POST', nb(''), {
					...body,
					compute_profile: 'default',
				}),
				400,
			);
		});

		it('treats a non-default profile named "default" as selectable, not the clear sentinel', async () => {
			const req = createTestApi({
				bucket,
				deps: {
					sandbox: {
						bucket: { name: 'test', endpoint: '' },
						hostname: 'localhost',
						workdir: '/workspace',
						persistWorkspace: 'source',
						computeProfiles: [
							{ name: 'small', resources: { cpu: 1 } },
							{ name: 'default', resources: { cpu: 4 } },
						],
						computeProfileOverride: 'editors',
					},
				},
			}).request;

			const created = await expectOk<any>(
				await req('POST', nb(''), {
					title: 'NB',
					description: 'D',
					code: 'x = 1',
					compute_profile: 'default',
				}),
				201,
			);
			expect(created.compute_profile).toBe('default');
		});
	});

	it('POST /git creates a git-synced draft notebook with sync credentials', async () => {
		const data = await expectOk<any>(
			await request('POST', nb('/git'), {
				title: 'GitHub app',
				description: 'Synced',
				repo: 'org/repo',
				branch: 'main',
				root_path: 'apps',
				entry_notebook: 'my_app.py',
			}),
			201,
		);

		expect(data.notebook.status).toBe('draft');
		// The create response carries the public meta shape, not the internal schema_version.
		expect(data.notebook.schema_version).toBeUndefined();
		expect(data.sync_url).toContain(`/api/sync/git/v1/projects/${projectId}/notebooks/`);
		expect(data.sync_token).toMatch(/^mhsync_/);

		const detail = await expectOk<any>(await request('GET', nb(`/${data.notebook.id}`)));
		expect(detail.source).toMatchObject({
			type: 'git',
			provider: 'github',
			repo: 'org/repo',
			branch: 'main',
			root_path: 'apps',
			entry_notebook: 'my_app.py',
			current_version_id: null,
		});
		expect(JSON.stringify(detail.source)).not.toContain(data.sync_token);
	});

	it('PATCH /{nid}/source updates a draft git source directly', async () => {
		const created = await expectOk<any>(
			await request('POST', nb('/git'), {
				title: 'GitHub app',
				description: 'Synced',
				repo: 'org/repo',
				branch: 'main',
				entry_notebook: 'app.py',
			}),
			201,
		);

		const data = await expectOk<any>(
			await request('PATCH', nb(`/${created.notebook.id}/source`), {
				repo: 'new/repo',
				branch: 'release',
				root_path: 'apps',
				entry_notebook: 'dashboard.py',
			}),
		);

		expect(data.source).toMatchObject({
			type: 'git',
			repo: 'new/repo',
			branch: 'release',
			root_path: 'apps',
			entry_notebook: 'dashboard.py',
			current_version_id: null,
		});
		expect(data.source.pending_config).toBeUndefined();
	});

	it('PATCH /{nid}/source stages changes after the first sync', async () => {
		const created = await expectOk<any>(
			await request('POST', nb('/git'), {
				title: 'GitHub app',
				description: 'Synced',
				repo: 'org/repo',
				branch: 'main',
				entry_notebook: 'app.py',
			}),
			201,
		);
		await expectOk(
			await app.request(`/api/sync/git/v1/projects/${projectId}/notebooks/${created.notebook.id}`, {
				method: 'POST',
				body: zipSync({ 'app.py': encode('print("old")') }),
				headers: {
					Authorization: `Bearer ${created.sync_token}`,
					'Content-Type': 'application/zip',
					'X-Marimohub-Repo': 'org/repo',
					'X-Marimohub-Branch': 'main',
					'X-Marimohub-Commit': 'abc123',
				},
			}),
		);

		const data = await expectOk<any>(
			await request('PATCH', nb(`/${created.notebook.id}/source`), {
				repo: 'new/repo',
				branch: 'release',
				root_path: 'apps',
				entry_notebook: 'dashboard.py',
			}),
		);

		expect(data.source.repo).toBe('org/repo');
		expect(data.source.pending_config).toEqual({
			repo: 'new/repo',
			branch: 'release',
			root_path: 'apps',
			entry_notebook: 'dashboard.py',
		});
		const content = await expectOk<any>(
			await request('GET', nb(`/${created.notebook.id}/content`)),
		);
		expect(content.code).toBe('print("old")');
	});

	it('PATCH /{nid}/source rejects local notebooks and viewers', async () => {
		const local = await expectOk<any>(
			await request('POST', nb(''), { title: 'NB', description: 'D', code: 'x = 1' }),
			201,
		);
		const body = {
			repo: 'org/repo',
			branch: 'main',
			root_path: '',
			entry_notebook: 'app.py',
		};
		await expectError(await request('PATCH', nb(`/${local.id}/source`), body), 400, 'BAD_REQUEST');

		const synced = await expectOk<any>(
			await request('POST', nb('/git'), {
				title: 'GitHub app',
				description: 'Synced',
				...body,
			}),
			201,
		);
		const viewer = createTestApi({
			bucket,
			userId: uid('user_viewer'),
			deps: { policy: { defaultRole: 'viewer' } },
		}).request;
		await expectError(
			await viewer('PATCH', nb(`/${synced.notebook.id}/source`), body),
			403,
			'FORBIDDEN',
		);
	});

	it('POST sync endpoint accepts a zip archive and updates GitHub content', async () => {
		const created = await expectOk<any>(
			await request('POST', nb('/git'), {
				title: 'GitHub app',
				description: 'Synced',
				repo: 'org/repo',
				branch: 'main',
				entry_notebook: 'apps/my_app.py',
			}),
			201,
		);
		const archive = zipSync({
			'apps/my_app.py': new TextEncoder().encode('print("from GitHub")'),
			'data/cars.csv': new TextEncoder().encode('a,b\n1,2\n'),
		});

		const sync = await app.request(
			`/api/sync/git/v1/projects/${projectId}/notebooks/${created.notebook.id}`,
			{
				method: 'POST',
				body: archive,
				headers: {
					Authorization: `Bearer ${created.sync_token}`,
					'Content-Type': 'application/zip',
					'X-Marimohub-Repo': 'org/repo',
					'X-Marimohub-Branch': 'main',
					'X-Marimohub-Commit': 'abc123',
				},
			},
		);
		const syncData = await expectOk<any>(sync);
		expect(syncData.notebook.status).toBe('active');
		// Sync returns the public meta shape — no internal schema_version leaks out.
		expect(syncData.notebook.schema_version).toBeUndefined();

		const content = await expectOk<any>(
			await request('GET', nb(`/${created.notebook.id}/content`)),
		);
		expect(content.code).toBe('print("from GitHub")');
		expect(
			await expectPage(await request('GET', nb(`/${created.notebook.id}/versions`))),
		).toHaveLength(1);
	});

	it('POST sync endpoint accepts a tar archive for a configured repo subdirectory', async () => {
		const created = await expectOk<any>(
			await request('POST', nb('/git'), {
				title: 'GitHub app',
				description: 'Synced',
				repo: 'org/repo',
				branch: 'main',
				root_path: 'apps',
				entry_notebook: 'my_app.py',
			}),
			201,
		);
		const archive = tarArchive({
			'my_app.py': 'print("from tar")',
			'data/cars.csv': 'a,b\n1,2\n',
		});

		await expectOk<any>(
			await app.request(`/api/sync/git/v1/projects/${projectId}/notebooks/${created.notebook.id}`, {
				method: 'POST',
				body: archive,
				headers: {
					Authorization: `Bearer ${created.sync_token}`,
					'Content-Type': 'application/x-tar',
					'X-Marimohub-Repo': 'org/repo',
					'X-Marimohub-Branch': 'main',
					'X-Marimohub-Root-Path': 'apps',
					'X-Marimohub-Commit': 'abc123',
				},
			}),
		);

		const content = await expectOk<any>(
			await request('GET', nb(`/${created.notebook.id}/content`)),
		);
		expect(content.code).toBe('print("from tar")');
	});

	it('POST sync endpoint rejects missing or stale tokens', async () => {
		const created = await expectOk<any>(
			await request('POST', nb('/git'), {
				title: 'GitHub app',
				description: 'Synced',
				repo: 'org/repo',
				branch: 'main',
				entry_notebook: 'app.py',
			}),
			201,
		);
		const archive = zipSync({ 'app.py': new TextEncoder().encode('print(1)') });

		await expectError(
			await app.request(`/api/sync/git/v1/projects/${projectId}/notebooks/${created.notebook.id}`, {
				method: 'POST',
				body: archive,
				headers: {
					'Content-Type': 'application/zip',
					'X-Marimohub-Repo': 'org/repo',
					'X-Marimohub-Branch': 'main',
					'X-Marimohub-Commit': 'abc123',
				},
			}),
			401,
			'UNAUTHORIZED',
		);

		const rotated = await expectOk<any>(
			await request('POST', nb(`/${created.notebook.id}/sync-token/rotate`)),
		);
		await expectError(
			await app.request(`/api/sync/git/v1/projects/${projectId}/notebooks/${created.notebook.id}`, {
				method: 'POST',
				body: archive,
				headers: {
					Authorization: `Bearer ${created.sync_token}`,
					'Content-Type': 'application/zip',
					'X-Marimohub-Repo': 'org/repo',
					'X-Marimohub-Branch': 'main',
					'X-Marimohub-Commit': 'abc123',
				},
			}),
			401,
			'UNAUTHORIZED',
		);
		expect(rotated.sync_token).not.toBe(created.sync_token);
	});

	it('POST sync endpoint rejects malformed bearer headers', async () => {
		const created = await expectOk<any>(
			await request('POST', nb('/git'), {
				title: 'GitHub app',
				description: 'Synced',
				repo: 'org/repo',
				branch: 'main',
				entry_notebook: 'app.py',
			}),
			201,
		);

		await expectError(
			await app.request(`/api/sync/git/v1/projects/${projectId}/notebooks/${created.notebook.id}`, {
				method: 'POST',
				body: zipSync({ 'app.py': encode('print(1)') }),
				headers: {
					Authorization: 'Token nope',
				},
			}),
			400,
			'BAD_REQUEST',
		);
	});

	it('POST sync endpoint rejects unsafe archive paths', async () => {
		const created = await expectOk<any>(
			await request('POST', nb('/git'), {
				title: 'GitHub app',
				description: 'Synced',
				repo: 'org/repo',
				branch: 'main',
				entry_notebook: 'app.py',
			}),
			201,
		);
		const archive = zipSync({ '../app.py': new TextEncoder().encode('print(1)') });

		await expectError(
			await app.request(`/api/sync/git/v1/projects/${projectId}/notebooks/${created.notebook.id}`, {
				method: 'POST',
				body: archive,
				headers: {
					Authorization: `Bearer ${created.sync_token}`,
					'Content-Type': 'application/zip',
					'X-Marimohub-Repo': 'org/repo',
					'X-Marimohub-Branch': 'main',
					'X-Marimohub-Commit': 'abc123',
				},
			}),
			400,
			'BAD_REQUEST',
		);
	});

	it('POST sync endpoint rejects source mismatch and unsupported archive formats', async () => {
		const created = await expectOk<any>(
			await request('POST', nb('/git'), {
				title: 'GitHub app',
				description: 'Synced',
				repo: 'org/repo',
				branch: 'main',
				root_path: 'apps',
				entry_notebook: 'app.py',
			}),
			201,
		);

		await expectError(
			await app.request(`/api/sync/git/v1/projects/${projectId}/notebooks/${created.notebook.id}`, {
				method: 'POST',
				body: zipSync({ 'app.py': encode('print(1)') }),
				headers: {
					Authorization: `Bearer ${created.sync_token}`,
					'Content-Type': 'application/zip',
					'X-Marimohub-Repo': 'org/repo',
					'X-Marimohub-Branch': 'main',
					'X-Marimohub-Root-Path': 'other',
					'X-Marimohub-Commit': 'abc123',
				},
			}),
			400,
			'BAD_REQUEST',
		);

		await expectError(
			await app.request(`/api/sync/git/v1/projects/${projectId}/notebooks/${created.notebook.id}`, {
				method: 'POST',
				body: encode('not an archive'),
				headers: {
					Authorization: `Bearer ${created.sync_token}`,
					'Content-Type': 'application/octet-stream',
					'X-Marimohub-Repo': 'org/repo',
					'X-Marimohub-Branch': 'main',
					'X-Marimohub-Root-Path': 'apps',
					'X-Marimohub-Commit': 'abc123',
				},
			}),
			400,
			'BAD_REQUEST',
		);
	});

	it('POST validates body — missing required code', async () => {
		await expectError(await request('POST', nb(''), { title: 'NB', description: 'D' }), 422);
	});

	it('GET /{nid} returns notebook detail', async () => {
		const created = await expectOk<any>(
			await request('POST', nb(''), { title: 'NB', description: 'D', code: 'c' }),
			201,
		);

		const data = await expectOk<any>(await request('GET', nb(`/${created.id}`)));
		expect(data.meta.title).toBe('NB');
		expect(data.source.type).toBe('local');
	});

	it('GET /{nid}/content returns code', async () => {
		const created = await expectOk<any>(
			await request('POST', nb(''), { title: 'NB', description: 'D', code: 'print(42)' }),
			201,
		);

		const data = await expectOk<any>(await request('GET', nb(`/${created.id}/content`)));
		expect(data.code).toBe('print(42)');
	});

	it('PUT /{nid} updates notebook', async () => {
		const created = await expectOk<any>(
			await request('POST', nb(''), { title: 'Old', description: 'D', code: 'v1' }),
			201,
		);

		const data = await expectOk<any>(
			await request('PATCH', nb(`/${created.id}`), {
				title: 'New',
				code: 'v2',
				message: 'updated',
			}),
		);
		expect(data.title).toBe('New');
	});

	it('DELETE /{nid} soft-deletes notebook', async () => {
		const created = await expectOk<any>(
			await request('POST', nb(''), { title: 'NB', description: 'D', code: 'c' }),
			201,
		);

		await expectOk(await request('DELETE', nb(`/${created.id}`)));

		expect(await expectPage(await request('GET', nb('')))).toHaveLength(0);
	});

	it('GET /{nid}/versions lists versions', async () => {
		const created = await expectOk<any>(
			await request('POST', nb(''), { title: 'NB', description: 'D', code: 'v1' }),
			201,
		);

		await request('PATCH', nb(`/${created.id}`), { code: 'v2', message: 'update' });

		expect(await expectPage(await request('GET', nb(`/${created.id}/versions`)))).toHaveLength(2);
	});

	it('GET /{nid}/workspace.zip returns the workspace as a zip', async () => {
		const created = await expectOk<any>(
			await request('POST', nb(''), {
				title: 'NB',
				description: 'D',
				code: 'import marimo',
				deps: '[project]\nname = "x"\n',
			}),
			201,
		);

		const res = await request('GET', nb(`/${created.id}/workspace.zip`));
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/zip');
		expect(res.headers.get('content-disposition')).toContain('attachment');

		const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
		expect(strFromU8(files['notebook.py'])).toBe('import marimo');
		expect(strFromU8(files['pyproject.toml'])).toBe('[project]\nname = "x"\n');
	});

	it('GET /{nid}/workspace.zip returns 404 for a missing notebook', async () => {
		await expectError(await request('GET', nb('/nb-0000000000000000/workspace.zip')), 404);
	});

	it('GET /{nid}/workspace.zip 404s for a malformed (path-traversal-shaped) notebook id', async () => {
		// `bad..id` fails NotebookId.is → NotFound, never reaching a store read.
		await expectError(await request('GET', nb('/bad..id/workspace.zip')), 404, 'NOT_FOUND');
	});

	it('GET /{nid} (and /content, /html) 404s for a notebook in a DIFFERENT project', async () => {
		// Notebook lives in `projectId`; a second project the caller also owns does not.
		const created = await expectOk<any>(
			await request('POST', nb(''), { title: 'NB', description: 'D', code: 'v1' }),
			201,
		);
		const other = await createServices(bucket).projects.createProject(
			{ name: 'Other', description: 'd' },
			ACTOR,
		);
		const foreign = (path: string) => `/projects/${other.id}/notebooks/${created.id}${path}`;

		await expectError(await request('GET', foreign('')), 404, 'NOT_FOUND');
		await expectError(await request('GET', foreign('/content')), 404, 'NOT_FOUND');
		await expectError(await request('GET', foreign('/html')), 404, 'NOT_FOUND');
	});

	it('GET /{nid}/versions/{vid} returns specific version', async () => {
		const created = await expectOk<any>(
			await request('POST', nb(''), { title: 'NB', description: 'D', code: 'v1' }),
			201,
		);

		const versions = await expectPage<any>(await request('GET', nb(`/${created.id}/versions`)));

		const data = await expectOk<any>(
			await request('GET', nb(`/${created.id}/versions/${versions[0].version_id}`)),
		);
		expect(data.code).toBe('v1');
		expect(data.version.version_id).toBe(versions[0].version_id);
	});

	it('POST /{nid}/versions/{vid}/restore restores a prior version as a new save', async () => {
		const created = await expectOk<any>(
			await request('POST', nb(''), { title: 'NB', description: 'D', code: 'v1' }),
			201,
		);
		await request('PATCH', nb(`/${created.id}`), { code: 'v2', message: 'update' });

		const versions = await expectPage<any>(await request('GET', nb(`/${created.id}/versions`)));
		expect(versions).toHaveLength(2);
		// Newest-first ordering: the initial version (code 'v1') is last.
		const initial = versions[versions.length - 1];

		const restored = await expectOk<any>(
			await request('POST', nb(`/${created.id}/versions/${initial.version_id}/restore`)),
			201,
		);
		expect(restored.id).toBe(created.id);

		// Current content is back to 'v1', cut as a NEW version (history preserved).
		const content = await expectOk<any>(await request('GET', nb(`/${created.id}/content`)));
		expect(content.code).toBe('v1');
		expect(await expectPage(await request('GET', nb(`/${created.id}/versions`)))).toHaveLength(3);
	});

	it('POST restore returns 404 for an unknown version', async () => {
		const created = await expectOk<any>(
			await request('POST', nb(''), { title: 'NB', description: 'D', code: 'v1' }),
			201,
		);
		await expectError(
			await request('POST', nb(`/${created.id}/versions/${createVersionId()}/restore`)),
			404,
		);
	});

	it('a non-member super admin can read and edit notebooks', async () => {
		const created = await expectOk<any>(
			await request('POST', nb(''), { title: 'NB', description: 'D', code: 'v1' }),
			201,
		);
		const god = createTestApi({
			bucket,
			userId: uid('user_god'),
			deps: { policy: { superAdmins: [uid('user_god')] } },
		}).request;
		expect((await expectOk<any>(await god('GET', nb(`/${created.id}`)))).meta.title).toBe('NB');
		await expectOk(await god('PATCH', nb(`/${created.id}`), { title: 'Edited' }));
	});

	it('POST restore requires editor (403 for a non-member)', async () => {
		const created = await expectOk<any>(
			await request('POST', nb(''), { title: 'NB', description: 'D', code: 'v1' }),
			201,
		);
		const versions = await expectPage<any>(await request('GET', nb(`/${created.id}/versions`)));
		const stranger = createTestApi({ bucket, userId: uid('user_z') }).request;
		await expectError(
			await stranger('POST', nb(`/${created.id}/versions/${versions[0].version_id}/restore`)),
			403,
		);
	});

	it('GET /{nid}/html returns 404 NO_HTML_SNAPSHOT when no version has one', async () => {
		const created = await expectOk<any>(
			await request('POST', nb(''), { title: 'NB', description: 'D', code: 'v1' }),
			201,
		);
		await expectError(await request('GET', nb(`/${created.id}/html`)), 404, 'NO_HTML_SNAPSHOT');
	});

	it('GET /{nid}/html returns 404 for an unknown notebook', async () => {
		await expectError(await request('GET', nb(`/${createNotebookId()}/html`)), 404, 'NOT_FOUND');
	});

	it('GET /{nid}/html serves the latest snapshot raw, sandboxed by CSP', async () => {
		const created = await expectOk<any>(
			await request('POST', nb(''), { title: 'NB', description: 'D', code: 'v1' }),
			201,
		);
		const committed = await createServices(bucket).notebooks.commitSession(
			projectId,
			created.id,
			{ code: 'v2', html: '<html><body>outputs</body></html>' },
			ACTOR,
		);

		const res = await request('GET', nb(`/${created.id}/html`));
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('text/html');
		// User-generated HTML: must be forced into an opaque origin, never sniffed.
		expect(res.headers.get('Content-Security-Policy')).toBe('sandbox allow-scripts');
		expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
		// Never disk-cached: a shared machine must not replay private outputs after logout.
		expect(res.headers.get('Cache-Control')).toBe('private, no-store');
		expect(res.headers.get('X-Marimohub-Version-Id')).toBe(committed!.versionId);
		expect(res.headers.get('X-Marimohub-Captured-At')).toBeTruthy();
		expect(await res.text()).toBe('<html><body>outputs</body></html>');
	});

	it('GET /{nid}/html is visibility-gated: 404 for a non-member, 200 for a default-role viewer', async () => {
		const created = await expectOk<any>(
			await request('POST', nb(''), { title: 'NB', description: 'D', code: 'v1' }),
			201,
		);
		await createServices(bucket).notebooks.commitSession(
			projectId,
			created.id,
			{ code: 'v2', html: '<html>x</html>' },
			ACTOR,
		);

		// Under MARIMOHUB_DEFAULT_ROLE=none a non-member cannot even see the project.
		const stranger = createTestApi({ bucket, userId: uid('user_z') }).request;
		await expectError(await stranger('GET', nb(`/${created.id}/html`)), 404, 'NOT_FOUND');

		const viewer = createTestApi({
			bucket,
			userId: uid('user_v'),
			deps: { policy: { defaultRole: 'viewer' } },
		}).request;
		expect((await viewer('GET', nb(`/${created.id}/html`))).status).toBe(200);
	});

	it('POST /{nid}/duplicate copies a notebook into a new one', async () => {
		const created = await expectOk<any>(
			await request('POST', nb(''), {
				title: 'Original',
				description: 'D',
				code: 'x = 1',
				tags: ['finance'],
			}),
			201,
		);

		const copy = await expectOk<any>(
			await request('POST', nb(`/${created.id}/duplicate`), {}),
			201,
		);
		expect(copy.id).not.toBe(created.id);
		expect(copy.title).toBe('Original (copy)');
		expect(copy.tags).toEqual(['finance']);

		const content = await expectOk<any>(await request('GET', nb(`/${copy.id}/content`)));
		expect(content.code).toBe('x = 1');
	});

	it('POST /{nid}/duplicate honors an explicit title', async () => {
		const created = await expectOk<any>(
			await request('POST', nb(''), { title: 'NB', description: 'D', code: 'c' }),
			201,
		);
		const copy = await expectOk<any>(
			await request('POST', nb(`/${created.id}/duplicate`), { title: 'My Fork' }),
			201,
		);
		expect(copy.title).toBe('My Fork');
	});

	it('POST /{nid}/duplicate returns 404 for an unknown notebook', async () => {
		await expectError(await request('POST', nb(`/${createNotebookId()}/duplicate`), {}), 404);
	});

	it('POST /{nid}/duplicate requires editor (403 for a non-member)', async () => {
		const created = await expectOk<any>(
			await request('POST', nb(''), { title: 'NB', description: 'D', code: 'c' }),
			201,
		);
		const stranger = createTestApi({ bucket, userId: uid('user_z') }).request;
		await expectError(await stranger('POST', nb(`/${created.id}/duplicate`), {}), 403);
	});

	// A default role makes every authenticated user a viewer without a membership
	// lookup — but it must not also skip the project's lifecycle check, or a
	// soft-deleted project's code stays readable for the whole GC grace period.
	describe.each(['viewer', 'editor'] as const)('soft-deleted project (default %s)', (role) => {
		let created: any;
		let read: ReturnType<typeof createTestApi>['request'];

		beforeEach(async () => {
			created = await expectOk<any>(
				await request('POST', nb(''), { title: 'NB', description: 'D', code: 'v1' }),
				201,
			);
			await expectOk(await request('DELETE', `/projects/${projectId}`));
			read = createTestApi({
				bucket,
				userId: uid('user_default_role'),
				deps: { policy: { defaultRole: role } },
			}).request;
		});

		it.each([
			['list notebooks', ''],
			['notebook detail', '/{nid}'],
			['notebook content', '/{nid}/content'],
			['notebook versions', '/{nid}/versions'],
			['HTML snapshot', '/{nid}/html'],
		])('%s returns 404', async (_label, suffix) => {
			const res = await read('GET', nb(suffix.replace('{nid}', created.id)));
			await expectError(res, 404, 'NOT_FOUND');
		});
	});

	it('GET exposes an ETag; PUT/DELETE honor If-Match', async () => {
		const created = await expectOk<any>(
			await request('POST', nb(''), { title: 'NB', description: 'D', code: 'v1' }),
			201,
		);

		const get = await request('GET', nb(`/${created.id}`));
		const etag = get.headers.get('ETag');
		expect(etag).toBe(`"${created.updated_at}"`);

		await expectError(
			await request('PATCH', nb(`/${created.id}`), { title: 'X' }, { 'If-Match': '"stale"' }),
			412,
			'PRECONDITION_FAILED',
		);

		const ok = await expectOk<any>(
			await request('PATCH', nb(`/${created.id}`), { title: 'New' }, { 'If-Match': etag! }),
		);
		expect(ok.title).toBe('New');

		await expectError(
			await request('DELETE', nb(`/${created.id}`), undefined, { 'If-Match': '"stale"' }),
			412,
			'PRECONDITION_FAILED',
		);
	});
});
