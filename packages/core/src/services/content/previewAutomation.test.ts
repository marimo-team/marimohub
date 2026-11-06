import { describe, expect, it } from 'vitest';
import { automationName } from './previewAutomation';
import { PreviewRecordSchema, previewExpired } from './notebookPreviews';
import { createNotebookId, createPreviewId, createProjectId } from '../../ids';
import { ACTOR } from '../../testing/fixtures';

describe('preview automation names and compatibility', () => {
	it('preserves branch names and suffixes within the name limit', () => {
		const hash = 'a'.repeat(64);
		const commit = 'b'.repeat(40);
		expect(automationName('feature/chart', hash)).toBe('feature/chart');
		expect(automationName('feature/chart', hash, commit)).toBe('feature/chart-bbbbbbbbbbbb');
		const long = automationName('feature/'.repeat(30), hash, commit);
		expect(long).toHaveLength(100);
		expect(long).toMatch(/-aaaaaaaaaaaa-bbbbbbbbbbbb$/);
		expect(automationName('feature/'.repeat(30), 'c'.repeat(64), commit)).not.toBe(long);
	});

	it('reads old records with their finite expiry and implicit eager behavior', () => {
		const record = PreviewRecordSchema.parse({
			schema_version: 1,
			id: createPreviewId(),
			project_id: createProjectId(),
			notebook_id: createNotebookId(),
			name: 'Existing',
			source: { type: 'commit', commit: 'a'.repeat(40) },
			repository: 'owner/repo',
			root_path: '',
			entry_notebook: 'notebook.py',
			created_by: ACTOR,
			created_at: new Date().toISOString(),
			expires_at: new Date(Date.now() + 86400000).toISOString(),
			request_fingerprint: 'existing',
			state: 'active',
			preparation: 'pending',
			revisions: [],
		});
		expect(record.eager).toBeUndefined();
		expect(record.automation).toBeUndefined();
		expect(previewExpired(record)).toBe(false);
		expect(previewExpired({ expires_at: '2000-01-01T00:00:00.000Z' })).toBe(true);
		expect(previewExpired({ expires_at: null })).toBe(false);
	});
	it.each(['requested_commit', 'observed_commit'] as const)(
		'validates persisted %s as a full commit SHA',
		(field) => {
			const schema = PreviewRecordSchema.shape[field];
			for (const value of ['a'.repeat(40), 'ABCDEF0123'.repeat(4), undefined])
				expect(schema.safeParse(value).success).toBe(true);
			for (const value of [
				'',
				'a'.repeat(12),
				'a'.repeat(41),
				'g'.repeat(40),
				`${'a'.repeat(39)}\n`,
			])
				expect(schema.safeParse(value).success).toBe(false);
		},
	);
});
