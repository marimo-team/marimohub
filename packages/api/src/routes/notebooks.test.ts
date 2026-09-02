import { describe, it, expect, beforeEach, vi } from 'vitest';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import {
	createNotebookId,
	createServices,
	createVersionId,
	MAX_WORKSPACE_FILE_BYTES,
} from '@marimo-hub/core';
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
	let services: ReturnType<typeof createServices>;
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
		services = api.deps.services;
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

	describe('list filters', () => {
		const create = (title: string, description: string, tags: string[]) =>
			request('POST', nb(''), { title, description, tags, code: 'import marimo' });

		it('filters by status, exact tag, and case-insensitive title or description text', async () => {
			const finance = await expectOk<any>(
				await create('Revenue Review', 'Monthly totals', ['finance']),
				201,
			);
			const operations = await expectOk<any>(
				await create('Capacity', 'Quarterly PIPELINE forecast', ['finance-archive']),
				201,
			);
			const deleted = await expectOk<any>(
				await create('Retired Revenue', 'Historical totals', ['retired']),
				201,
			);
			await expectOk(await request('DELETE', nb(`/${deleted.id}`)));

			expect(
				(await expectPage<any>(await request('GET', nb('?status=deleted')))).map((n) => n.id),
			).toEqual([deleted.id]);
			expect(
				(await expectPage<any>(await request('GET', nb('?tag=finance')))).map((n) => n.id),
			).toEqual([finance.id]);
			expect(
				(await expectPage<any>(await request('GET', nb('?q=pipeline')))).map((n) => n.id),
			).toEqual([operations.id]);
			expect(
				(await expectPage<any>(await request('GET', nb('?q=REVENUE')))).map((n) => n.id),
			).toEqual([finance.id]);
			expect(
				(await expectPage<any>(await request('GET', nb(''))))
					.map((n) => n.id)
					.sort((a, b) => a.localeCompare(b)),
			).toEqual([finance.id, operations.id].sort((a, b) => a.localeCompare(b)));
		});

		it('ANDs filters and paginates the filtered set', async () => {
			const matching: string[] = [];
			for (let i = 0; i < 3; i++) {
				const notebook = await expectOk<any>(
					await create(`Match ${i}`, `Search target ${i}`, ['selected']),
					201,
				);
				matching.push(notebook.id);
			}
			await create('Wrong tag', 'Search target', ['other']);
			await create('Wrong text', 'Unrelated', ['selected']);

			const first = await expectOk<any>(
				await request('GET', nb('?status=active&tag=selected&q=TARGET&limit=2')),
			);
			expect(first.items).toHaveLength(2);
			expect(first.next_cursor).toBeTruthy();

			const second = await expectOk<any>(
				await request(
					'GET',
					nb(
						`?status=active&tag=selected&q=TARGET&limit=2&cursor=${encodeURIComponent(first.next_cursor)}`,
					),
				),
			);
			expect(second.items).toHaveLength(1);
			expect(second.next_cursor).toBeNull();
			const ids = [...first.items, ...second.items].map((notebook: any) => notebook.id);
			expect(ids.sort((a, b) => a.localeCompare(b))).toEqual(
				matching.sort((a, b) => a.localeCompare(b)),
			);
		});

		it('treats empty search as unfiltered and returns a terminal empty page for misses', async () => {
			await create('Revenue', 'Monthly totals', ['finance']);
			await create('Capacity', 'Quarterly forecast', ['operations']);

			const unfiltered = await expectOk<any>(await request('GET', nb('')));
			const emptySearch = await expectOk<any>(await request('GET', nb('?q=')));
			expect(emptySearch).toEqual(unfiltered);

			for (const query of ['tag=Finance', 'q=missing']) {
				const page = await expectOk<any>(await request('GET', nb(`?${query}`)));
				expect(page).toEqual({ items: [], next_cursor: null });
			}
		});

		it('can combine status, tag, and text filters for deleted notebooks', async () => {
			const live = await expectOk<any>(
				await create('Live audit', 'Compliance records', ['audit']),
				201,
			);
			const deleted = await expectOk<any>(
				await create('Retired audit', 'Compliance records', ['audit']),
				201,
			);
			await expectOk(await request('DELETE', nb(`/${deleted.id}`)));

			const page = await expectOk<any>(
				await request('GET', nb('?status=deleted&tag=audit&q=COMPLIANCE')),
			);
			expect(page).toEqual({
				items: [expect.objectContaining({ id: deleted.id })],
				next_cursor: null,
			});
			expect(page.items.map((item: any) => item.id)).not.toContain(live.id);
		});

		it.each(['status=unknown', 'limit=0', 'limit=-1', 'limit=1.5', 'limit=nope'])(
			'rejects invalid query parameter %s',
			async (query) => {
				await expectError(await request('GET', nb(`?${query}`)), 422, 'VALIDATION_ERROR');
			},
		);

		it('rejects a malformed cursor on a filtered request', async () => {
			await expectError(
				await request('GET', nb('?tag=finance&cursor=not~base64')),
				400,
				'BAD_REQUEST',
			);
		});
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
			await expectError(await profileApi('none')('POST', nb(''), body), 403, 'FORBIDDEN');
			await expectError(
				await profileApi('none')('POST', nb(''), {
					...body,
					compute_profile: 'default',
				}),
				403,
				'FORBIDDEN',
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

	it('requires a manager to select or change a server-side repository', async () => {
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
		const editor = uid('git-source-editor');
		await createServices(bucket).projects.addMember(
			projectId,
			{ user_id: editor },
			'editor',
			ACTOR,
		);
		const editorRequest = createTestApi({ bucket, userId: editor }).request;

		await expectError(
			await editorRequest('POST', nb('/git'), {
				title: 'Other repository',
				description: 'Synced',
				repo: 'private/other',
				branch: 'main',
				entry_notebook: 'app.py',
			}),
			403,
			'FORBIDDEN',
		);
		await expectError(
			await editorRequest('PATCH', nb(`/${created.notebook.id}/source`), {
				repo: 'private/other',
				branch: 'main',
				root_path: '',
				entry_notebook: 'app.py',
			}),
			403,
			'FORBIDDEN',
		);
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
		await expectError(await request('PATCH', nb(`/${local.id}/source`), body), 409, 'CONFLICT');

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
			422,
			'VALIDATION_ERROR',
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

	describe('workspace browser', () => {
		it('supports binary file CRUD, search, copy, move, and source-file versions', async () => {
			const created = await expectOk<any>(
				await request('POST', nb(''), {
					title: 'NB',
					description: 'D',
					code: 'print(1)',
				}),
				201,
			);
			const workspace = nb(`/${created.id}/workspace`);

			const access = await expectOk<any>(await request('GET', `${workspace}/access`));
			expect(access).toMatchObject({ writable: true, read_only_reason: null });
			expect(access.protected_paths.map((rule: any) => rule.path)).toEqual([
				'/notebook.py',
				'/pyproject.toml',
			]);

			await expectOk(
				await app.request(
					`/api/v1${workspace}/files?path=${encodeURIComponent('/data/raw.bin')}&create=true`,
					{ method: 'PUT', body: new Uint8Array([0, 1, 2, 255]) },
				),
			);
			const file = await app.request(
				`/api/v1${workspace}/files?path=${encodeURIComponent('/data/raw.bin')}`,
			);
			expect(file.headers.get('cache-control')).toBe('private, no-store');
			expect(file.headers.get('content-disposition')).toContain('attachment;');
			expect(file.headers.get('x-content-type-options')).toBe('nosniff');
			expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 255]));

			const root = await expectOk<any>(await request('GET', `${workspace}/entries?path=/`));
			expect(root.items).toContainEqual(
				expect.objectContaining({ path: '/data', kind: 'directory' }),
			);
			const search = await expectOk<any>(
				await request('GET', `${workspace}/search?path=/&query=raw`),
			);
			expect(search.items[0].path).toBe('/data/raw.bin');

			await expectOk(
				await request('POST', `${workspace}/copy`, {
					from: '/data/raw.bin',
					to: '/data/copy.bin',
				}),
			);
			await expectOk(
				await request('POST', `${workspace}/move`, {
					from: '/data/copy.bin',
					to: '/moved.bin',
				}),
			);
			await expectOk(
				await request('DELETE', `${workspace}/entries?path=${encodeURIComponent('/moved.bin')}`),
			);

			await expectOk(
				await app.request(
					`/api/v1${workspace}/files?path=${encodeURIComponent('/pyproject.toml')}`,
					{ method: 'PUT', body: '[project]\nname = "changed"\n' },
				),
			);
			expect(await expectPage(await request('GET', nb(`/${created.id}/versions`)))).toHaveLength(2);

			await expectError(
				await request('DELETE', `${workspace}/entries?path=${encodeURIComponent('/notebook.py')}`),
				403,
				'FORBIDDEN',
			);
			await expectError(
				await request('POST', `${workspace}/move`, {
					from: '/data/raw.bin',
					to: '/pyproject.toml',
				}),
				403,
				'FORBIDDEN',
			);
			const spacedSourcePath = `/api/v1${workspace}/files?path=${encodeURIComponent('/notebook.py ')}`;
			await expectOk(
				await app.request(`${spacedSourcePath}&create=true`, {
					method: 'PUT',
					body: 'auxiliary',
				}),
			);
			expect(await (await app.request(spacedSourcePath)).text()).toBe('auxiliary');
			await expectOk(
				await request('DELETE', `${workspace}/entries?path=${encodeURIComponent('/notebook.py ')}`),
			);
			expect((await expectOk<any>(await request('GET', nb(`/${created.id}/content`)))).code).toBe(
				'print(1)',
			);
		});

		it('paginates directory listings with an explicit limit', async () => {
			const created = await expectOk<any>(
				await request('POST', nb(''), { title: 'NB', description: 'D', code: 'print(1)' }),
				201,
			);
			const workspace = nb(`/${created.id}/workspace`);
			for (const name of ['a.txt', 'b.txt']) {
				await expectOk(
					await app.request(
						`/api/v1${workspace}/files?path=${encodeURIComponent(`/${name}`)}&create=true`,
						{ method: 'PUT', body: name },
					),
				);
			}

			const first = await expectOk<any>(
				await request('GET', `${workspace}/entries?path=/&limit=2`),
			);
			expect(first.items).toHaveLength(2);
			expect(first.cursor).toBeTruthy();
			const rest = await expectOk<any>(
				await request(
					'GET',
					`${workspace}/entries?path=/&limit=2&cursor=${encodeURIComponent(first.cursor)}`,
				),
			);
			expect(rest.items).toHaveLength(2);
			expect(rest.cursor).toBeUndefined();
			expect(
				[...first.items, ...rest.items]
					.map((item: any) => item.path as string)
					.sort((a, b) => a.localeCompare(b)),
			).toEqual(['/a.txt', '/b.txt', '/notebook.py', '/pyproject.toml']);
			for (const limit of ['0', '501', 'many']) {
				await expectError(
					await request('GET', `${workspace}/entries?path=/&limit=${limit}`),
					422,
					'VALIDATION_ERROR',
				);
			}
		});

		it('refuses protected source paths as copy and directory targets', async () => {
			const created = await expectOk<any>(
				await request('POST', nb(''), { title: 'NB', description: 'D', code: 'print(1)' }),
				201,
			);
			const workspace = nb(`/${created.id}/workspace`);
			await expectOk(
				await app.request(
					`/api/v1${workspace}/files?path=${encodeURIComponent('/raw.py')}&create=true`,
					{ method: 'PUT', body: 'print(2)' },
				),
			);

			await expectError(
				await request('POST', `${workspace}/copy`, { from: '/raw.py', to: '/notebook.py' }),
				403,
				'FORBIDDEN',
			);
			await expectError(
				await request('POST', `${workspace}/directories`, { path: '/pyproject.toml' }),
				403,
				'FORBIDDEN',
			);
			expect((await expectOk<any>(await request('GET', nb(`/${created.id}/content`)))).code).toBe(
				'print(1)',
			);
			expect(await expectPage(await request('GET', nb(`/${created.id}/versions`)))).toHaveLength(1);
		});

		it('rejects a mutation when an edit session starts after the pre-flight check', async () => {
			const created = await expectOk<any>(
				await request('POST', nb(''), { title: 'NB', description: 'D', code: 'print(1)' }),
				201,
			);
			const workspace = nb(`/${created.id}/workspace`);
			const sessions = services.sessions;
			const listActive = sessions.listActiveByProject.bind(sessions);
			let raced = false;
			vi.spyOn(sessions, 'listActiveByProject').mockImplementation(async (pid) => {
				const active = await listActive(pid);
				if (!raced) {
					raced = true;
					await sessions.createSession({
						project_id: projectId,
						notebook_id: created.id,
						user_id: ACTOR,
						mode: 'edit',
					});
				}
				return active;
			});

			await expectError(
				await request('POST', `${workspace}/directories`, { path: '/raced' }),
				409,
				'CONFLICT',
			);
			expect(raced).toBe(true);
			const root = await expectOk<any>(await request('GET', `${workspace}/entries?path=/`));
			expect(root.items.map((item: any) => item.path)).not.toContain('/raced');
		});

		it('returns stable errors for collisions, traversal, and oversized uploads', async () => {
			const created = await expectOk<any>(
				await request('POST', nb(''), { title: 'NB', description: 'D', code: 'print(1)' }),
				201,
			);
			const workspace = nb(`/${created.id}/workspace`);
			const fileUrl = `/api/v1${workspace}/files?path=${encodeURIComponent('/data.txt')}&create=true`;

			await expectOk(await app.request(fileUrl, { method: 'PUT', body: 'first' }));
			await expectError(
				await app.request(fileUrl, { method: 'PUT', body: 'second' }),
				409,
				'CONFLICT',
			);
			await expectError(
				await app.request(
					`/api/v1${workspace}/files?path=${encodeURIComponent('/../secret.txt')}`,
					{ method: 'PUT', body: 'blocked' },
				),
				400,
				'BAD_REQUEST',
			);
			await expectError(
				await app.request(`/api/v1${workspace}/files?path=${encodeURIComponent('/large.bin')}`, {
					method: 'PUT',
					body: 'x',
					headers: { 'content-length': String(MAX_WORKSPACE_FILE_BYTES + 1) },
				}),
				413,
				'PAYLOAD_TOO_LARGE',
			);
			await expectError(
				await app.request(
					`/api/v1${workspace}/files?path=${encodeURIComponent('/other.txt')}&create=sometimes`,
					{ method: 'PUT', body: 'x' },
				),
				400,
				'BAD_REQUEST',
			);
		});

		it('rejects ambiguous, control-character, and malformed workspace inputs', async () => {
			const created = await expectOk<any>(
				await request('POST', nb(''), { title: 'NB', description: 'D', code: 'print(1)' }),
				201,
			);
			const workspace = nb(`/${created.id}/workspace`);

			for (const path of [
				'//server/share',
				'/data/../secret',
				'/data/a\0b',
				'/data/a\nb',
				'/.marimohub-directory',
				'/data/.marimohub-directory/file',
			]) {
				await expectError(
					await app.request(`/api/v1${workspace}/files?path=${encodeURIComponent(path)}`, {
						method: 'PUT',
						body: 'blocked',
					}),
					400,
					'BAD_REQUEST',
				);
			}
			await expectError(await app.request(`/api/v1${workspace}/files`), 400, 'BAD_REQUEST');
			await expectError(
				await request('POST', `${workspace}/move`, { from: '/notebook.py' }),
				422,
				'VALIDATION_ERROR',
			);
			await expectError(
				await request('GET', `${workspace}/search?path=/&query=`),
				422,
				'VALIDATION_ERROR',
			);

			await expectError(
				await app.request(`/api/v1${workspace}/files?path=${encodeURIComponent('/notebook.py')}`, {
					method: 'PUT',
					body: Uint8Array.from([0xc3, 0x28]),
				}),
				400,
				'BAD_REQUEST',
			);
			expect((await expectOk<any>(await request('GET', nb(`/${created.id}/content`)))).code).toBe(
				'print(1)',
			);
			expect(await expectPage(await request('GET', nb(`/${created.id}/versions`)))).toHaveLength(1);
		});

		it('forces browser-executable files to download instead of rendering inline', async () => {
			const created = await expectOk<any>(
				await request('POST', nb(''), { title: 'NB', description: 'D', code: 'print(1)' }),
				201,
			);
			const workspace = nb(`/${created.id}/workspace`);
			const filename = "payload!o'clock(x)*.html";
			const url = `/api/v1${workspace}/files?path=${encodeURIComponent(`/${filename}`)}`;
			await expectOk(await app.request(url, { method: 'PUT', body: '<script>alert(1)</script>' }));

			const response = await app.request(url);
			expect(response.headers.get('content-type')).toBe('application/octet-stream');
			expect(response.headers.get('content-disposition')).toBe(
				`attachment; filename="${filename}"; filename*=UTF-8''payload%21o%27clock%28x%29%2A.html`,
			);
			expect(response.headers.get('x-content-type-options')).toBe('nosniff');
			expect(response.headers.get('cache-control')).toBe('private, no-store');
			expect(await response.text()).toBe('<script>alert(1)</script>');
		});

		it('exposes git workspaces as read-only', async () => {
			const created = await expectOk<any>(
				await request('POST', nb('/git'), {
					title: 'Git',
					description: 'D',
					repo: 'org/repo',
					branch: 'main',
					entry_notebook: 'app.py',
				}),
				201,
			);
			const workspace = nb(`/${created.notebook.id}/workspace`);
			expect(await expectOk<any>(await request('GET', `${workspace}/access`))).toMatchObject({
				writable: false,
				read_only_reason: 'git_source',
			});
			await expectError(
				await app.request(`/api/v1${workspace}/files?path=${encodeURIComponent('/app.py')}`, {
					method: 'PUT',
					body: 'print(2)',
				}),
				403,
				'FORBIDDEN',
			);
			for (const [method, path, body] of [
				['POST', `${workspace}/directories`, { path: '/blocked' }],
				['DELETE', `${workspace}/entries?path=${encodeURIComponent('/app.py')}`, undefined],
				['POST', `${workspace}/copy`, { from: '/app.py', to: '/copy.py' }],
				['POST', `${workspace}/move`, { from: '/app.py', to: '/moved.py' }],
			] as const) {
				await expectError(await request(method, path, body), 403, 'FORBIDDEN');
			}
		});

		it('blocks local mutations during edit sessions but not app sessions', async () => {
			const created = await expectOk<any>(
				await request('POST', nb(''), { title: 'NB', description: 'D', code: 'print(1)' }),
				201,
			);
			const workspace = nb(`/${created.id}/workspace`);
			const sessions = services.sessions;
			const appSession = await sessions.createSession({
				project_id: projectId,
				notebook_id: created.id,
				user_id: ACTOR,
				mode: 'app',
			});

			expect(await expectOk<any>(await request('GET', `${workspace}/access`))).toMatchObject({
				writable: true,
				read_only_reason: null,
			});
			await expectOk(
				await request('POST', `${workspace}/directories`, { path: '/created-by-app-session' }),
				201,
			);
			await expectOk(
				await app.request(
					`/api/v1${workspace}/files?path=${encodeURIComponent('/data.txt')}&create=true`,
					{ method: 'PUT', body: 'data' },
				),
			);
			await sessions.terminate(projectId, appSession.session_id);
			await sessions.createSession({
				project_id: projectId,
				notebook_id: created.id,
				user_id: ACTOR,
				mode: 'edit',
			});

			expect(await expectOk<any>(await request('GET', `${workspace}/access`))).toMatchObject({
				writable: false,
				read_only_reason: 'active_session',
			});
			await expectOk(await request('GET', `${workspace}/entries?path=/`));
			await expectError(
				await request('POST', `${workspace}/directories`, { path: '/blocked' }),
				409,
				'CONFLICT',
			);
			await expectError(
				await app.request(`/api/v1${workspace}/files?path=${encodeURIComponent('/blocked.txt')}`, {
					method: 'PUT',
					body: 'blocked',
				}),
				409,
				'CONFLICT',
			);
			await expectError(
				await request('POST', `${workspace}/copy`, {
					from: '/data.txt',
					to: '/copy.txt',
				}),
				409,
				'CONFLICT',
			);
			await expectError(
				await request('POST', `${workspace}/move`, {
					from: '/data.txt',
					to: '/moved.txt',
				}),
				409,
				'CONFLICT',
			);
			await expectError(
				await request('DELETE', `${workspace}/entries?path=${encodeURIComponent('/data.txt')}`),
				409,
				'CONFLICT',
			);
		});

		it('allows viewers to browse and download but rejects mutations', async () => {
			const created = await expectOk<any>(
				await request('POST', nb(''), { title: 'NB', description: 'D', code: 'print(1)' }),
				201,
			);
			const viewer = uid('workspace-viewer');
			await createServices(bucket).projects.addMember(
				projectId,
				{ user_id: viewer },
				'viewer',
				ACTOR,
			);
			const viewerApi = createTestApi({ bucket, userId: viewer });
			const workspace = nb(`/${created.id}/workspace`);

			expect(
				await expectOk<any>(await viewerApi.request('GET', `${workspace}/access`)),
			).toMatchObject({ writable: false, read_only_reason: 'viewer' });
			const source = await viewerApi.app.request(
				`/api/v1${workspace}/files?path=${encodeURIComponent('/notebook.py')}`,
			);
			expect(source.status).toBe(200);
			expect(await source.text()).toBe('print(1)');
			await expectError(
				await viewerApi.request('POST', `${workspace}/directories`, { path: '/blocked' }),
				403,
				'FORBIDDEN',
			);
			await expectError(
				await viewerApi.app.request(
					`/api/v1${workspace}/files?path=${encodeURIComponent('/notebook.py')}`,
					{ method: 'PUT', body: 'blocked' },
				),
				403,
				'FORBIDDEN',
			);
			for (const [method, path, body] of [
				['DELETE', `${workspace}/entries?path=${encodeURIComponent('/notebook.py')}`, undefined],
				['POST', `${workspace}/copy`, { from: '/notebook.py', to: '/copy.py' }],
				['POST', `${workspace}/move`, { from: '/notebook.py', to: '/moved.py' }],
			] as const) {
				await expectError(await viewerApi.request(method, path, body), 403, 'FORBIDDEN');
			}
		});

		it('does not reveal workspace contents to project non-members', async () => {
			const created = await expectOk<any>(
				await request('POST', nb(''), { title: 'NB', description: 'D', code: 'secret = 1' }),
				201,
			);
			const outsider = createTestApi({ bucket, userId: uid('workspace-outsider') });
			const workspace = nb(`/${created.id}/workspace`);

			for (const path of [
				`${workspace}/access`,
				`${workspace}/entries?path=/`,
				`${workspace}/search?path=/&query=notebook`,
			]) {
				await expectError(await outsider.request('GET', path), 404, 'NOT_FOUND');
			}
			await expectError(
				await outsider.app.request(
					`/api/v1${workspace}/files?path=${encodeURIComponent('/notebook.py')}`,
				),
				404,
				'NOT_FOUND',
			);
			await expectError(
				await outsider.request('POST', `${workspace}/directories`, { path: '/blocked' }),
				403,
				'FORBIDDEN',
			);
		});
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

	it('GET /{nid}/versions/{vid}/html serves that version’s snapshot with the same containment headers', async () => {
		const created = await expectOk<any>(
			await request('POST', nb(''), { title: 'NB', description: 'D', code: 'v1' }),
			201,
		);
		const services = createServices(bucket);
		const first = await services.notebooks.commitSession(
			projectId,
			created.id,
			{ code: 'v2', html: '<html>first</html>' },
			ACTOR,
		);
		await services.notebooks.commitSession(
			projectId,
			created.id,
			{ code: 'v3', html: '<html>second</html>' },
			ACTOR,
		);

		// The pinned version, not the latest.
		const res = await request('GET', nb(`/${created.id}/versions/${first!.versionId}/html`));
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Security-Policy')).toBe('sandbox allow-scripts');
		expect(res.headers.get('Cache-Control')).toBe('private, no-store');
		expect(res.headers.get('X-Marimohub-Version-Id')).toBe(first!.versionId);
		expect(await res.text()).toBe('<html>first</html>');
	});

	it('GET /{nid}/versions/{vid}/html 404s: NO_HTML_SNAPSHOT for a snapshot-less version, NOT_FOUND for an unknown one', async () => {
		const created = await expectOk<any>(
			await request('POST', nb(''), { title: 'NB', description: 'D', code: 'v1' }),
			201,
		);
		// The initial save captured no HTML.
		const versions = await expectOk<any>(await request('GET', nb(`/${created.id}/versions`)));
		const vid = versions.items[0].version_id;
		await expectError(
			await request('GET', nb(`/${created.id}/versions/${vid}/html`)),
			404,
			'NO_HTML_SNAPSHOT',
		);
		await expectError(
			await request('GET', nb(`/${created.id}/versions/${createVersionId()}/html`)),
			404,
			'NOT_FOUND',
		);
	});

	it('GET /{nid}/versions/{vid}/html is visibility-gated like the latest-snapshot route', async () => {
		const created = await expectOk<any>(
			await request('POST', nb(''), { title: 'NB', description: 'D', code: 'v1' }),
			201,
		);
		const committed = await createServices(bucket).notebooks.commitSession(
			projectId,
			created.id,
			{ code: 'v2', html: '<html>x</html>' },
			ACTOR,
		);
		const path = nb(`/${created.id}/versions/${committed!.versionId}/html`);

		// Under MARIMOHUB_DEFAULT_ROLE=none a non-member cannot even see the project.
		const stranger = createTestApi({ bucket, userId: uid('user_z') }).request;
		await expectError(await stranger('GET', path), 404, 'NOT_FOUND');

		const viewer = createTestApi({
			bucket,
			userId: uid('user_v'),
			deps: { policy: { defaultRole: 'viewer' } },
		}).request;
		expect((await viewer('GET', path)).status).toBe(200);
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
