import { describe, expect, it } from 'vitest';
import {
	AlertDestinationId,
	createAlertDestinationId,
	deriveProposalId,
	createNotebookId,
	createProjectId,
	createSandboxId,
	createSessionId,
	createVersionId,
	NotebookId,
	ProposalId,
	ProjectId,
	SandboxId,
	SessionId,
	SnapshotId,
	UserId,
	VersionId,
} from './ids';
import type { IdBrand } from './ids';

// Crockford base32 (lowercase, ambiguous letters i/l/o/u removed).
const CROCKFORD_RE = /^[0-9a-hjkmnp-tv-z]{16}$/;

describe('createSandboxId', () => {
	it('has the sb- prefix', () => {
		expect(createSandboxId()).toMatch(/^sb-/);
	});

	it('has a 16-char Crockford base32 body after the prefix', () => {
		const id = createSandboxId();
		const body = id.slice('sb-'.length);
		expect(body).toMatch(CROCKFORD_RE);
	});

	it('matches the full ^sb-[0-9a-hjkmnp-tv-z]{16}$ pattern', () => {
		for (let i = 0; i < 20; i++) {
			expect(createSandboxId()).toMatch(/^sb-[0-9a-hjkmnp-tv-z]{16}$/);
		}
	});

	it('produces distinct values (uniqueness across 1000 draws)', () => {
		const ids = new Set(Array.from({ length: 1000 }, () => createSandboxId()));
		expect(ids.size).toBe(1000);
	});
});

describe('other id factories (contract)', () => {
	it('createProjectId matches proj-<16-char body>', () => {
		expect(createProjectId()).toMatch(/^proj-[0-9a-hjkmnp-tv-z]{16}$/);
	});

	it('createNotebookId matches nb-<16-char body>', () => {
		expect(createNotebookId()).toMatch(/^nb-[0-9a-hjkmnp-tv-z]{16}$/);
	});

	it('createSessionId matches sess-<16-char body>', () => {
		expect(createSessionId()).toMatch(/^sess-[0-9a-hjkmnp-tv-z]{16}$/);
	});

	it('createAlertDestinationId matches alert-<16-char body>', () => {
		expect(createAlertDestinationId()).toMatch(/^alert-[0-9a-hjkmnp-tv-z]{16}$/);
	});
});

// --- Namespace helpers: is() / assert() / parse() ---

// The hyphen-bodied ids share a format, so they share a
// table of expectations. VersionId differs (uppercase ULID) and is below.
const hyphenIds: { name: string; id: IdBrand<string>; prefix: string }[] = [
	{ name: 'AlertDestinationId', id: AlertDestinationId, prefix: 'alert-' },
	{ name: 'ProjectId', id: ProjectId, prefix: 'proj-' },
	{ name: 'NotebookId', id: NotebookId, prefix: 'nb-' },
	{ name: 'ProposalId', id: ProposalId, prefix: 'prop-' },
	{ name: 'SnapshotId', id: SnapshotId, prefix: 'snap-' },
	{ name: 'SessionId', id: SessionId, prefix: 'sess-' },
	{ name: 'SandboxId', id: SandboxId, prefix: 'sb-' },
];

for (const { name, id, prefix } of hyphenIds) {
	describe(`${name} namespace`, () => {
		it('is() accepts a freshly-created id', () => {
			expect(id.is(id.create())).toBe(true);
		});

		it('is() rejects the wrong prefix, bad length, uppercase, and non-strings', () => {
			expect(id.is(`wrong-${'a'.repeat(16)}`)).toBe(false);
			expect(id.is(`${prefix}${'a'.repeat(15)}`)).toBe(false);
			expect(id.is(`${prefix}${'a'.repeat(17)}`)).toBe(false);
			expect(id.is(`${prefix}${'A'.repeat(16)}`)).toBe(false);
			expect(id.is(undefined)).toBe(false);
			expect(id.is(42)).toBe(false);
		});

		it('parse() round-trips a valid id and throws (with the type name) on a bad one', () => {
			const valid = id.create();
			expect(id.parse(valid)).toBe(valid);
			expect(() => id.parse(`bad-${name}`)).toThrow(name);
		});

		it('assert() passes for a valid id and throws otherwise', () => {
			expect(() => id.assert(id.create())).not.toThrow();
			expect(() => id.assert('nope')).toThrow(name);
		});

		it('exposes its format regex as the single source of truth', () => {
			expect(id.regex.test(id.create())).toBe(true);
		});
	});
}

describe('VersionId namespace', () => {
	it('is() accepts a freshly-created uppercase-ULID id', () => {
		expect(VersionId.is(VersionId.create())).toBe(true);
	});

	it('is() rejects a lowercase body and the hyphen separator', () => {
		expect(VersionId.is(`ver_${'a'.repeat(26)}`)).toBe(false);
		expect(VersionId.is(`ver-${'A'.repeat(26)}`)).toBe(false);
	});

	it('parse() round-trips a valid id and throws on a bad one', () => {
		const valid = VersionId.create();
		expect(VersionId.parse(valid)).toBe(valid);
		expect(() => VersionId.parse('ver_lowercase')).toThrow('VersionId');
	});

	it('createVersionId sorts monotonically for ids minted within the same millisecond', () => {
		// The monotonic factory guarantees strictly-increasing (lexicographic) ids even
		// under a frozen clock — version pruning treats the largest id as newest.
		const ids = Array.from({ length: 50 }, () => createVersionId());
		const sorted = [...ids].sort();
		expect(ids).toEqual(sorted);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe('deriveProposalId', () => {
	it('returns the same valid proposal id for the same scoped seed', async () => {
		const first = await deriveProposalId('user\nroute\nretry-key');
		const second = await deriveProposalId('user\nroute\nretry-key');

		expect(second).toBe(first);
		expect(ProposalId.is(first)).toBe(true);
		expect(await deriveProposalId('user\nroute\nother-key')).not.toBe(first);
	});
});

describe('UserId (opaque brand)', () => {
	it('rejects the empty string', () => {
		expect(UserId.is('')).toBe(false);
		expect(() => UserId.assert('')).toThrow('UserId');
		expect(() => UserId.parse('')).toThrow('UserId');
	});

	it('accepts a non-empty opaque sub like "system"', () => {
		expect(UserId.is('system')).toBe(true);
		expect(UserId.parse('system')).toBe('system');
	});
});
