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
	CatalogSchema,
	EventSchema,
	IdentitySchema,
	NotebookIdSchema,
	parseStored,
	readStored,
	ProjectIdSchema,
	ProjectMemberSchema,
	ProjectSchema,
	SessionIdSchema,
	SnapshotIdSchema,
	SnapshotProjectEntrySchema,
	SnapshotSchema,
	SourceSchema,
	VersionIdSchema,
	toPublicNotebookEntry,
	toPublicProjectEntry,
} from './schema';
import {
	makeCatalog,
	makeProject,
	makeSnapshotNotebookEntry,
	makeSnapshotProjectEntry,
	ACTOR,
	NOW,
} from './testing';

describe('IdentitySchema', () => {
	const identity = {
		id: 'user-1',
		email: 'user@example.com',
		name: 'User',
		updated_at: NOW,
	};

	it('accepts an HTTPS profile-picture URL', () => {
		expect(
			IdentitySchema.safeParse({
				...identity,
				picture_url: 'https://images.example.com/avatar.png',
			}).success,
		).toBe(true);
	});

	it('accepts active legacy records and an optional suspension timestamp', () => {
		expect(IdentitySchema.parse(identity)).not.toHaveProperty('suspended_at');
		expect(
			IdentitySchema.parse({ ...identity, suspended_at: '2026-08-11T18:00:00.000Z' }),
		).toMatchObject({ suspended_at: '2026-08-11T18:00:00.000Z' });
		expect(IdentitySchema.safeParse({ ...identity, suspended_at: 'yesterday' }).success).toBe(
			false,
		);
	});

	it.each([
		['HTTP', 'http://images.example.com/avatar.png'],
		['non-HTTP', 'ftp://images.example.com/avatar.png'],
		['invalid', 'not-a-url'],
	])('rejects a %s profile-picture URL', (_label, pictureUrl) => {
		expect(IdentitySchema.safeParse({ ...identity, picture_url: pictureUrl }).success).toBe(false);
	});
});

describe('parseStored', () => {
	const schema = z.object({ a: z.number() });

	it('returns the parsed value on a match', () => {
		expect(parseStored(schema, { a: 1 }, 'thing')).toEqual({ a: 1 });
	});

	it('throws a labeled error with value-free schema diagnostics', () => {
		try {
			parseStored(schema, { a: 'do-not-log-this' }, '_system/catalog.json');
			expect.unreachable('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toBe('Stored data is temporarily unavailable');
			expect(err).toMatchObject({
				reason: 'schema_mismatch',
				object: '_system/catalog.json',
				issues: [{ path: 'a', code: 'invalid_type' }],
			});
			expect(JSON.stringify(err)).not.toContain('do-not-log-this');
		}
	});

	it('labels invalid JSON without retaining parser text or bytes', async () => {
		const body = {
			json: () => Promise.reject(new SyntaxError('secret bytes at position 7')),
		};
		await expect(readStored(schema, body, 'projects/x/project.json')).rejects.toMatchObject({
			reason: 'invalid_json',
			object: 'projects/x/project.json',
			cause_name: 'SyntaxError',
		});
		try {
			await readStored(schema, body, 'projects/x/project.json');
		} catch (err) {
			expect(JSON.stringify(err)).not.toContain('secret bytes');
		}
	});

	it('caps retained schema issues', () => {
		const many = z.array(z.number());
		try {
			parseStored(
				many,
				Array.from({ length: 50 }, () => 'bad'),
				'_system/many.json',
			);
			expect.unreachable('should have thrown');
		} catch (err) {
			expect((err as { issues: unknown[] }).issues).toHaveLength(20);
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
			id: '01HXYZ9ABCDEFGHJKMNPQRSTVW',
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
			EventSchema.safeParse({
				id: '01HXYZ9ABCDEFGHJKMNPQRSTVW',
				schema_version: 1,
				ts: 'not-a-date',
				event: 'x',
				actor: ACTOR,
			}).success,
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

	it('parses a git source with pending settings', () => {
		const src = SourceSchema.parse({
			schema_version: 1,
			type: 'git',
			provider: 'github',
			repo: 'marimo-team/marimo',
			branch: 'main',
			root_path: 'apps',
			entry_notebook: 'my_app.py',
			pending_config: {
				repo: 'marimo-team/marimohub',
				branch: 'release',
				root_path: 'examples',
				entry_notebook: 'dashboard.py',
			},
			sync_mode: 'push',
			current_version_id: createVersionId(),
			commit: 'deadbeef',
			last_synced_at: NOW,
		});
		expect(src.type).toBe('git');
		if (src.type === 'git') {
			expect(src.pending_config?.entry_notebook).toBe('dashboard.py');
		}
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

describe('CatalogSchema', () => {
	it('parses a well-formed v1 catalog', () => {
		const catalog = makeCatalog(createSnapshotId());
		expect(CatalogSchema.parse(catalog).version).toBe(1);
	});

	it('rejects a catalog whose version is not 1 (strict literal, not forward-tolerant)', () => {
		const catalog = { ...makeCatalog(createSnapshotId()), version: 2 };
		expect(CatalogSchema.safeParse(catalog).success).toBe(false);
	});
});

describe('status defaulting', () => {
	it('SnapshotProjectEntrySchema defaults status to "active" when omitted', () => {
		const entry: Record<string, unknown> = {
			...makeSnapshotProjectEntry({ id: createProjectId() }),
		};
		delete entry.status;
		expect(SnapshotProjectEntrySchema.parse(entry).status).toBe('active');
	});

	it('ProjectSchema defaults status to "active" when omitted', () => {
		const project: Record<string, unknown> = { ...makeProject() };
		delete project.status;
		expect(ProjectSchema.parse(project).status).toBe('active');
	});
});

describe('SnapshotProjectEntrySchema (rolling-deploy tolerance)', () => {
	it('preserves unknown entry fields across a parse round-trip', () => {
		const entry = { ...makeSnapshotProjectEntry({ id: createProjectId() }), future_field: 'kept' };
		const parsed = SnapshotProjectEntrySchema.parse(entry);
		expect((parsed as Record<string, unknown>).future_field).toBe('kept');
	});

	// authz compares member_emails against subject.email.toLowerCase(), so the schema
	// must lowercase on parse or a mixed-case invite email would never match.
	it('lowercases member_emails on parse (so authz email matching holds)', () => {
		const entry = {
			...makeSnapshotProjectEntry({ id: createProjectId() }),
			member_emails: ['Alice@Example.COM'],
		};
		const parsed = SnapshotProjectEntrySchema.parse(entry);
		expect(parsed.member_emails).toEqual(['alice@example.com']);
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
