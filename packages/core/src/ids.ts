import { monotonicFactory } from 'ulidx';

// --- Sandbox IDs (existing) ---

export type SandboxId = string & { __brand: 'SandboxId' };

export function createSandboxId(): SandboxId {
	return crypto.randomUUID().slice(0, 8) as SandboxId;
}

// --- IDs for the bucket schema ---

export type ProjectId = string & { __brand: 'ProjectId' };
export type NotebookId = string & { __brand: 'NotebookId' };
export type SnapshotId = string & { __brand: 'SnapshotId' };
export type VersionId = string & { __brand: 'VersionId' };
export type SessionId = string & { __brand: 'SessionId' };

// Crockford's Base32 alphabet, lowercased and with the ambiguous letters
// (I, L, O, U) removed. Every character is a valid DNS label character, so ids
// built from it can live in a hostname/subdomain (e.g. `<nb>.marimohub.app`)
// without escaping, and read cleanly in a URL path.
const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

// Random-id body length, in characters. Each character carries 5 bits, so 16
// chars = 80 bits of entropy — the same randomness a ULID provides, which keeps
// these ids unguessable enough to expose as capability-style subdomains and
// collision-safe far past any realistic object count. These ids do not need to
// be time-sortable (unlike version/event ids below), so we drop the ULID
// timestamp prefix and keep them short.
const RANDOM_ID_LENGTH = 16;

function randomBody(): string {
	const bytes = new Uint8Array(RANDOM_ID_LENGTH);
	crypto.getRandomValues(bytes);
	let out = '';
	for (let i = 0; i < RANDOM_ID_LENGTH; i++) {
		// Low 5 bits of each byte map uniformly onto the 32-char alphabet.
		out += ID_ALPHABET[bytes[i] & 31];
	}
	return out;
}

export function createProjectId(): ProjectId {
	return `proj-${randomBody()}` as ProjectId;
}

export function createNotebookId(): NotebookId {
	return `nb-${randomBody()}` as NotebookId;
}

export function createSnapshotId(): SnapshotId {
	return `snap-${randomBody()}` as SnapshotId;
}

// Version ids use a monotonic ULID so versions created within the same
// millisecond still sort in creation order. Version pruning (NotebookService)
// keeps the newest N versions by treating the lexicographically-largest ids as
// newest, so non-monotonic ids would make pruning (and its tests) flaky.
const nextVersionUlid = monotonicFactory();

export function createVersionId(): VersionId {
	return `ver_${nextVersionUlid()}` as VersionId;
}

export function createSessionId(): SessionId {
	return `sess-${randomBody()}` as SessionId;
}

// Event object keys use a monotonic ULID so that, even when many events are
// written within the same millisecond, the keys still sort in append order.
// Events are stored one immutable object per event under a per-day prefix.
const nextEventUlid = monotonicFactory();

export function createEventId(): string {
	return nextEventUlid();
}
