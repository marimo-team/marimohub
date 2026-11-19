import { describe, expect, it, vi } from 'vitest';
import { createServices } from '../services';
import { SYSTEM_ACTOR, createProposalId, createSessionId, createVersionId } from '../ids';
import { workspaceManifest } from '../services/content/workspaceManifest';
import { proposalSha256 } from '../services/content/proposalUtils';
import { paths } from '../paths';
import { MemoryBucket } from '../testing/MemoryBucket';
import { auditMetadataReferences, validateMetadataRecord } from './metadataValidation';
import { classifyMetadataKey } from './metadataKeys';

describe('offline metadata validation', () => {
	async function fixture() {
		const bucket = new MemoryBucket();
		const services = createServices(bucket);
		await services.catalog.initialize(SYSTEM_ACTOR);
		const project = await services.projects.createProject(
			{ name: 'transfer', description: '' },
			SYSTEM_ACTOR,
		);
		const notebook = await services.notebooks.createNotebook(
			project.id,
			{ title: 'transfer', description: '', code: 'print(1)' },
			SYSTEM_ACTOR,
		);
		return { bucket, services, project, notebook };
	}
	it('validates domain-produced records without rewriting unknown fields or bytes', async () => {
		const { bucket } = await fixture();
		for (const object of (await bucket.list()).objects) {
			if (classifyMetadataKey(object.key) === 'metadata')
				await validateMetadataRecord((await bucket.get(object.key))!);
		}
		await auditMetadataReferences(bucket);
	});
	it('blocks missing published artifacts and leaves the source untouched', async () => {
		const { bucket, project, notebook } = await fixture();
		const sourceKey = paths.project(project.id).notebook(notebook.id).source;
		const source = await bucket.get(sourceKey);
		const code = (await bucket.list()).objects.find((object) =>
			object.key.endsWith('/notebook.py'),
		)!;
		await bucket.delete(code.key);
		await expect(auditMetadataReferences(bucket)).rejects.toThrow('Missing referenced object');
		expect((await bucket.head(sourceKey))!.etag).toBe(source!.etag);
	});
	it('blocks live and unreclaimed sessions', async () => {
		const { bucket, services, project, notebook } = await fixture();
		await services.sessions.createSession({
			project_id: project.id,
			notebook_id: notebook.id,
			user_id: SYSTEM_ACTOR,
			mode: 'edit',
		});
		await expect(auditMetadataReferences(bucket)).rejects.toThrow('Drain and reclaim');
	});
	it('checks binary workspace payload sizes and hashes', async () => {
		const { bucket, project, notebook } = await fixture();
		const version = paths.project(project.id).notebook(notebook.id).version(createVersionId());
		const bytes = new Uint8Array([0, 255, 128, 1]);
		await bucket.put(
			version.workspaceManifest,
			JSON.stringify(await workspaceManifest(new Map([['data.bin', bytes]]))),
		);
		await bucket.put(version.workspaceFile('data.bin'), bytes);
		await auditMetadataReferences(bucket);
		await bucket.put(version.workspaceFile('data.bin'), new Uint8Array([0, 255, 128, 2]));
		await expect(auditMetadataReferences(bucket)).rejects.toThrow(
			'Invalid referenced workspace artifact',
		);
		await bucket.delete(version.workspaceFile('data.bin'));
		await expect(auditMetadataReferences(bucket)).rejects.toThrow(
			'Invalid referenced workspace artifact',
		);
	});
	it.each(['../secret', 'data/../../secret', '/absolute', 'dir\\secret', 'a//b', 'a/./b', 'a\0b'])(
		'rejects unsafe workspace artifact paths before reading: %j',
		async (path) => {
			const { bucket, project, notebook } = await fixture();
			const version = paths.project(project.id).notebook(notebook.id).version(createVersionId());
			const bytes = new Uint8Array([1, 2, 3]);
			await bucket.put(
				version.workspaceManifest,
				JSON.stringify(await workspaceManifest(new Map([[path, bytes]]))),
			);
			const unsafeKey = version.workspaceFile(path);
			await bucket.put(unsafeKey, bytes);
			const read = vi.spyOn(bucket, 'get');
			await expect(auditMetadataReferences(bucket)).rejects.toThrow('workspace path');
			expect(read.mock.calls.some(([key]) => key === unsafeKey)).toBe(false);
		},
	);
	it('requires live proposal payloads but permits expired payload cleanup', async () => {
		const { bucket, project, notebook } = await fixture();
		const id = createProposalId();
		const proposal = paths.project(project.id).notebook(notebook.id).proposal(id);
		const bytes = new Uint8Array([255, 0, 128]);
		const record = {
			schema_version: 1,
			proposal_id: id,
			notebook_id: notebook.id,
			session_id: createSessionId(),
			author: SYSTEM_ACTOR,
			created_at: new Date().toISOString(),
			base_version_id: createVersionId(),
			source: {
				provider: 'github',
				repo: 'owner/repo',
				branch: 'main',
				root_path: '',
				commit: 'a'.repeat(40),
				entry_notebook: 'notebook.py',
			},
			changes: [
				{
					path: 'data.bin',
					operation: 'add',
					size_bytes: bytes.length,
					sha256: await proposalSha256(bytes),
				},
			],
		};
		await bucket.put(proposal.meta, JSON.stringify(record));
		await expect(auditMetadataReferences(bucket)).rejects.toThrow(
			'Invalid referenced proposal artifact',
		);
		await bucket.put(proposal.change(0), bytes);
		await auditMetadataReferences(bucket);
		await bucket.put(proposal.change(0), new Uint8Array([255, 0, 127]));
		await expect(auditMetadataReferences(bucket)).rejects.toThrow(
			'Invalid referenced proposal artifact',
		);
		await bucket.delete(proposal.change(0));
		await bucket.put(
			proposal.meta,
			JSON.stringify({ ...record, created_at: '2020-01-01T00:00:00Z' }),
		);
		await auditMetadataReferences(bucket);
	});

	it('accepts raw deletion timestamps and integration name tombstones', async () => {
		const bucket = new MemoryBucket();
		for (const [key, value] of [
			['_system/job-deletions/p/n/j.json', '2026-11-18T00:00:00Z'],
			[
				'_system/integrations/_names/name.json',
				JSON.stringify({ integration_id: null, claimed_at: '2026-11-18T00:00:00Z' }),
			],
		]) {
			await bucket.put(key, value);
			await validateMetadataRecord((await bucket.get(key))!);
		}
		await auditMetadataReferences(bucket);
	});
});
