import { describe, expect, it } from 'vitest';
import { createServices } from '../services';
import { SYSTEM_ACTOR } from '../ids';
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
});
