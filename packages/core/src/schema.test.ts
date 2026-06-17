import { describe, it, expect } from 'vitest';
import {
	createNotebookId,
	createProjectId,
	createSessionId,
	createSnapshotId,
	createVersionId,
} from './ids';
import { z } from 'zod';
import {
	EventSchema,
	NotebookIdSchema,
	parseStored,
	ProjectIdSchema,
	ProjectMemberSchema,
	SessionIdSchema,
	SnapshotIdSchema,
	SnapshotProjectEntrySchema,
	SnapshotSchema,
	SourceSchema,
	VersionIdSchema,
	toPublicNotebookEntry,
	toPublicProjectEntry,
} from './schema';
import { makeSnapshotNotebookEntry, makeSnapshotProjectEntry, ACTOR, NOW } from './testing';

describe('parseStored', () => {
	const schema = z.object({ a: z.number() });

	it('returns the parsed value on a match', () => {
		expect(parseStored(schema, { a: 1 }, 'thing')).toEqual({ a: 1 });
	});

	it('throws a labeled error that keeps the ZodError as cause', () => {
		try {
			parseStored(schema, { a: 'nope' }, '_system/catalog.json');
			expect.unreachable('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toBe('Corrupted stored object: _system/catalog.json');
			// The ZodError is preserved so logs can surface the failing field path.
			expect((err as Error).cause).toBeDefined();
			expect((err as { cause: { issues: unknown[] } }).cause.issues).toHaveLength(1);
		}
	});
});

describe('id schemas', () => {
	const cases = [
		{ name: 'ProjectId', schema: ProjectIdSchema, make: createProjectId, prefix: 'proj-' },
		{ name: 'NotebookId', schema: NotebookIdSchema, make: createNotebookId, prefix: 'nb-' },
		{ name: 'SnapshotId', schema: SnapshotIdSchema, make: createSnapshotId, prefix: 'snap-' },
		{ name: 'SessionId', schema: SessionIdSchema, make: createSessionId, prefix: 'sess-' },
	] as const;

	for (const { name, schema, make, prefix } of cases) {
		describe(name, () => {
			it('accepts freshly-generated ids', () => {
				const id = make();
				expect(schema.parse(id)).toBe(id);
			});

			it('rejects the wrong prefix', () => {
				expect(schema.safeParse(`wrong-${'a'.repeat(16)}`).success).toBe(false);
			});

			it('rejects a too-short body', () => {
				expect(schema.safeParse(`${prefix}${'a'.repeat(15)}`).success).toBe(false);
			});

			it('rejects a too-long body', () => {
				expect(schema.safeParse(`${prefix}${'a'.repeat(17)}`).success).toBe(false);
			});

			it('rejects uppercase / out-of-alphabet characters', () => {
				expect(schema.safeParse(`${prefix}${'A'.repeat(16)}`).success).toBe(false);
			});
		});
	}

	describe('VersionId', () => {
		it('accepts an uppercase ULID body', () => {
			const id = createVersionId();
			expect(VersionIdSchema.parse(id)).toBe(id);
		});

		it('rejects a lowercase body (ULIDs are uppercase)', () => {
			expect(VersionIdSchema.safeParse(`ver_${'a'.repeat(26)}`).success).toBe(false);
		});

		it('rejects the hyphen separator used by the other ids', () => {
			expect(VersionIdSchema.safeParse(`ver-${'A'.repeat(26)}`).success).toBe(false);
		});
	});
});

describe('SnapshotSchema (looseObject rolling-deploy invariant)', () => {
	function validSnapshot(extra: Record<string, unknown> = {}) {
		const project = makeSnapshotProjectEntry();
		return {
			snapshot_id: createSnapshotId(),
			schema_version: 1,
			created_at: NOW,
			operation: 'init',
			actor: ACTOR,
			projects: [project],
			...extra,
		};
	}

	it('parses a well-formed snapshot', () => {
		const parsed = SnapshotSchema.parse(validSnapshot());
		expect(parsed.projects).toHaveLength(1);
	});

	it('PRESERVES unknown top-level fields (old reader must not strip newer keys)', () => {
		// This is the "old code tolerates new" half of the rolling-deploy policy:
		// a v1 reader round-tripping a snapshot a newer replica wrote must keep the
		// extra fields, or the CAS re-write would silently delete the newer data.
		const parsed = SnapshotSchema.parse(validSnapshot({ future_field: { nested: 42 } })) as Record<
			string,
			unknown
		>;
		expect(parsed.future_field).toEqual({ nested: 42 });
	});

	it('is forward-tolerant on schema_version (accepts a newer version number)', () => {
		const parsed = SnapshotSchema.parse(validSnapshot({ schema_version: 2 }));
		expect(parsed.schema_version).toBe(2);
	});

	it('rejects a non-positive schema_version', () => {
		expect(SnapshotSchema.safeParse(validSnapshot({ schema_version: 0 })).success).toBe(false);
	});

	it('rejects a missing required field', () => {
		const bad = validSnapshot();
		delete (bad as Record<string, unknown>).actor;
		expect(SnapshotSchema.safeParse(bad).success).toBe(false);
	});
});

describe('EventSchema', () => {
	it('preserves unknown fields (loose, append-only event records)', () => {
		const parsed = EventSchema.parse({
			schema_version: 1,
			ts: NOW,
			event: 'session.started',
			actor: ACTOR,
			session_id: 'sess-abc',
		}) as Record<string, unknown>;
		expect(parsed.session_id).toBe('sess-abc');
	});

	it('rejects a bad timestamp', () => {
		expect(
			EventSchema.safeParse({ schema_version: 1, ts: 'not-a-date', event: 'x', actor: ACTOR })
				.success,
		).toBe(false);
	});
});

describe('SourceSchema (discriminated union)', () => {
	it('parses a local source', () => {
		const src = SourceSchema.parse({
			schema_version: 1,
			type: 'local',
			current_version_id: createVersionId(),
		});
		expect(src.type).toBe('local');
	});

	it('parses a git source', () => {
		const versionId = createVersionId();
		const src = SourceSchema.parse({
			schema_version: 1,
			type: 'git',
			provider: 'github',
			repo: 'marimo-team/marimo',
			branch: 'main',
			root_path: 'apps',
			entry_notebook: 'my_app.py',
			sync_mode: 'push',
			current_version_id: versionId,
			commit: 'deadbeef',
			last_synced_at: NOW,
		});
		expect(src.type).toBe('git');
		expect(src.current_version_id).toBe(versionId);
	});

	it('parses an unsynced git source draft', () => {
		const src = SourceSchema.parse({
			schema_version: 1,
			type: 'git',
			provider: 'github',
			repo: 'marimo-team/marimo',
			branch: 'main',
			root_path: '',
			entry_notebook: 'apps/my_app.py',
			sync_mode: 'push',
			current_version_id: null,
			commit: null,
			last_synced_at: null,
		});
		expect(src.type).toBe('git');
		expect(src.current_version_id).toBeNull();
	});

	it('rejects an unknown discriminant', () => {
		expect(SourceSchema.safeParse({ schema_version: 1, type: 'gitlab' }).success).toBe(false);
	});

	it('rejects a local source missing current_version_id', () => {
		expect(SourceSchema.safeParse({ schema_version: 1, type: 'local' }).success).toBe(false);
	});
});

describe('ProjectMemberSchema', () => {
	it('accepts a legacy id-only member and an email-only invite', () => {
		expect(ProjectMemberSchema.safeParse({ user_id: 'user_a', role: 'editor' }).success).toBe(true);
		expect(ProjectMemberSchema.safeParse({ email: 'a@x.io', role: 'viewer' }).success).toBe(true);
	});

	it('lowercases the email on parse, so authz matching holds for any stored casing', () => {
		expect(ProjectMemberSchema.parse({ email: 'Alice@X.io', role: 'viewer' })).toEqual({
			email: 'alice@x.io',
			role: 'viewer',
		});
	});

	it('rejects a member with both identifiers or neither', () => {
		expect(
			ProjectMemberSchema.safeParse({ user_id: 'user_a', email: 'a@x.io', role: 'editor' }).success,
		).toBe(false);
		expect(ProjectMemberSchema.safeParse({ role: 'editor' }).success).toBe(false);
	});
});

describe('SnapshotProjectEntrySchema (rolling-deploy tolerance)', () => {
	it('preserves unknown entry fields across a parse round-trip', () => {
		const entry = { ...makeSnapshotProjectEntry({ id: createProjectId() }), future_field: 'kept' };
		const parsed = SnapshotProjectEntrySchema.parse(entry);
		expect((parsed as Record<string, unknown>).future_field).toBe('kept');
	});

	it('toPublicProjectEntry never leaks preserved unknown fields', () => {
		const entry = SnapshotProjectEntrySchema.parse({
			...makeSnapshotProjectEntry({ id: createProjectId() }),
			future_field: 'internal',
		});
		expect(toPublicProjectEntry(entry)).not.toHaveProperty('future_field');
	});
});

describe('toPublic* strippers', () => {
	it('strips key_prefix from a notebook entry', () => {
		const pid = createProjectId();
		const entry = makeSnapshotNotebookEntry(pid);
		const pub = toPublicNotebookEntry(entry);
		expect('key_prefix' in pub).toBe(false);
		expect(pub.id).toBe(entry.id);
		expect(pub.title).toBe(entry.title);
	});

	it('drops the nested notebooks array from a project entry, keeping notebook_count', () => {
		const pid = createProjectId();
		const project = makeSnapshotProjectEntry({
			id: pid,
			notebooks: [makeSnapshotNotebookEntry(pid), makeSnapshotNotebookEntry(pid)],
			notebook_count: 2,
		});

		const pub = toPublicProjectEntry(project);

		expect('notebooks' in pub).toBe(false);
		// non-stripped fields survive
		expect(pub.id).toBe(pid);
		expect(pub.notebook_count).toBe(2);
	});

	it('does not mutate the original entry', () => {
		const pid = createProjectId();
		const entry = makeSnapshotNotebookEntry(pid);
		toPublicNotebookEntry(entry);
		expect(entry.key_prefix).toBeDefined();
	});
});
