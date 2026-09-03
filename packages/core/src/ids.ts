import { monotonicFactory } from 'ulidx';

// --- Branded id types ---
//
// Each id is a branded `string` so the type system keeps a ProjectId from being
// passed where a NotebookId is expected. The brand is purely compile-time; the
// runtime value is an ordinary string.

export type SandboxId = string & { __brand: 'SandboxId' };
export type ProjectId = string & { __brand: 'ProjectId' };
export type NotebookId = string & { __brand: 'NotebookId' };
export type SnapshotId = string & { __brand: 'SnapshotId' };
export type VersionId = string & { __brand: 'VersionId' };
export type ProposalId = string & { __brand: 'ProposalId' };
export type SessionId = string & { __brand: 'SessionId' };
export type TokenId = string & { __brand: 'TokenId' };
export type CliAuthorizationId = string & { __brand: 'CliAuthorizationId' };
export type OAuthClientId = string & { __brand: 'OAuthClientId' };
export type OAuthAuthorizationId = string & { __brand: 'OAuthAuthorizationId' };
export type IntegrationId = string & { __brand: 'IntegrationId' };
export type AlertDestinationId = string & { __brand: 'AlertDestinationId' };
export type JobId = string & { __brand: 'JobId' };
export type RunId = string & { __brand: 'RunId' };

// A user id is the opaque auth `sub` (OIDC / Cloudflare Access / dev). We do not
// mint or format it, so unlike the ids above it is a *nominal* brand only — it
// keeps a user string from being passed where a project/notebook id is expected,
// but there is no generator and no format regex to validate against.
export type UserId = string & { __brand: 'UserId' };

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

function bodyFromBytes(bytes: Uint8Array): string {
	let out = '';
	for (let i = 0; i < RANDOM_ID_LENGTH; i++) {
		// Low 5 bits of each byte map uniformly onto the 32-char alphabet.
		out += ID_ALPHABET[bytes[i] & 31];
	}
	return out;
}

function randomBody(): string {
	const bytes = new Uint8Array(RANDOM_ID_LENGTH);
	crypto.getRandomValues(bytes);
	return bodyFromBytes(bytes);
}

// Version ids use a monotonic ULID so versions created within the same
// millisecond still sort in creation order. Version pruning (NotebookService)
// keeps the newest N versions by treating the lexicographically-largest ids as
// newest, so non-monotonic ids would make pruning (and its tests) flaky.
const nextVersionUlid = monotonicFactory();

// Token ids are bare ULIDs (no `tok_` prefix): they ride inside the PAT string
// (`mhub_pat_<tokenId>_<secret>`), where `_` is the field separator.
const nextTokenUlid = monotonicFactory();

const nextCliAuthorizationUlid = monotonicFactory();
const nextOAuthClientUlid = monotonicFactory();
const nextOAuthAuthorizationUlid = monotonicFactory();

// Run ids are uppercase ULIDs like versions: newest-first listing and retention
// both rely on lexicographic key order being chronological.
const nextRunUlid = monotonicFactory();

// --- Id namespaces (guard / assert / parse / create) ---
//
// For each branded type we also export a same-named `const` (TypeScript merges
// the type and value declarations) grouping the runtime helpers. A const object
// rather than a class: the brand is a primitive string, which a class instance
// type would clash with.

export interface IdBrand<T extends string> {
	/** The format regex — the single source of truth, reused by zod schemas. */
	readonly regex: RegExp;
	is(value: unknown): value is T;
	/** Throws unless `value` is a valid id of this type; narrows otherwise. */
	assert(value: unknown): asserts value is T;
	/** Validates `value` and returns it branded, throwing on a bad value. */
	parse(value: string): T;
	create(): T;
}

function defineId<T extends string>(name: string, regex: RegExp, body: () => string): IdBrand<T> {
	const is = (value: unknown): value is T => typeof value === 'string' && regex.test(value);
	function assert(value: unknown): asserts value is T {
		if (!is(value)) {
			throw new Error(`Invalid ${name}: ${String(value)}`);
		}
	}
	return {
		regex,
		is,
		assert,
		parse(value: string): T {
			assert(value);
			return value;
		},
		create: () => body() as T,
	};
}

// proj/nb/snap/sess/sb ids are lowercase, hyphen-separated, 16-char random
// bodies (subdomain-safe, see above). ver ids stay uppercase ULIDs because
// their lexicographic order is load-bearing (version pruning).
//
// Sandbox ids double as capability tokens for the kernel preview URL, so the
// same 80-bit entropy scheme is critical there too.
export const SandboxId = defineId<SandboxId>(
	'SandboxId',
	/^sb-[0-9a-z]{16}$/,
	() => `sb-${randomBody()}`,
);
export const ProjectId = defineId<ProjectId>(
	'ProjectId',
	/^proj-[0-9a-z]{16}$/,
	() => `proj-${randomBody()}`,
);
export const NotebookId = defineId<NotebookId>(
	'NotebookId',
	/^nb-[0-9a-z]{16}$/,
	() => `nb-${randomBody()}`,
);
export const SnapshotId = defineId<SnapshotId>(
	'SnapshotId',
	/^snap-[0-9a-z]{16}$/,
	() => `snap-${randomBody()}`,
);
export const VersionId = defineId<VersionId>(
	'VersionId',
	/^ver_[0-9A-Z]{26}$/,
	() => `ver_${nextVersionUlid()}`,
);
export const ProposalId = defineId<ProposalId>(
	'ProposalId',
	/^prop-[0-9a-z]{16}$/,
	() => `prop-${randomBody()}`,
);
export const SessionId = defineId<SessionId>(
	'SessionId',
	/^sess-[0-9a-z]{16}$/,
	() => `sess-${randomBody()}`,
);
export const TokenId = defineId<TokenId>('TokenId', /^[0-9A-Z]{26}$/, () => nextTokenUlid());
export const CliAuthorizationId = defineId<CliAuthorizationId>(
	'CliAuthorizationId',
	/^[0-9A-Z]{26}$/,
	() => nextCliAuthorizationUlid(),
);
export const OAuthClientId = defineId<OAuthClientId>('OAuthClientId', /^[0-9A-Z]{26}$/, () =>
	nextOAuthClientUlid(),
);
export const OAuthAuthorizationId = defineId<OAuthAuthorizationId>(
	'OAuthAuthorizationId',
	/^[0-9A-Z]{26}$/,
	() => nextOAuthAuthorizationUlid(),
);
export const IntegrationId = defineId<IntegrationId>(
	'IntegrationId',
	/^intg-[0-9a-z]{16}$/,
	() => `intg-${randomBody()}`,
);
export const AlertDestinationId = defineId<AlertDestinationId>(
	'AlertDestinationId',
	/^alert-[0-9a-z]{16}$/,
	() => `alert-${randomBody()}`,
);
export const JobId = defineId<JobId>('JobId', /^job-[0-9a-z]{16}$/, () => `job-${randomBody()}`);
export const RunId = defineId<RunId>(
	'RunId',
	/^run_[0-9A-HJKMNP-TV-Z]{26}$/,
	() => `run_${nextRunUlid()}`,
);

// A brand with no format/generator — `is` only checks "non-empty string". Used
// for opaque provider ids (see UserId). `parse` brands a trusted value (e.g. an
// auth `sub`) at the boundary; `assert` narrows in place.
export interface OpaqueIdBrand<T extends string> {
	is(value: unknown): value is T;
	assert(value: unknown): asserts value is T;
	parse(value: string): T;
}

function defineOpaqueId<T extends string>(name: string): OpaqueIdBrand<T> {
	const is = (value: unknown): value is T => typeof value === 'string' && value.length > 0;
	function assert(value: unknown): asserts value is T {
		if (!is(value)) {
			throw new Error(`Invalid ${name}: ${String(value)}`);
		}
	}
	return {
		is,
		assert,
		parse(value: string): T {
			assert(value);
			return value;
		},
	};
}

export const UserId = defineOpaqueId<UserId>('UserId');

/** Synthetic actor stamped on system-initiated mutations (GC sweeps, migrations). */
export const SYSTEM_ACTOR: UserId = UserId.parse('system');

// --- Factory aliases ---
//
// `createXId()` kept as thin aliases of `XId.create` so existing call sites do
// not need to change.

export const createSandboxId = SandboxId.create;
export const createProjectId = ProjectId.create;
export const createNotebookId = NotebookId.create;
export const createSnapshotId = SnapshotId.create;
export const createVersionId = VersionId.create;
export const createProposalId = ProposalId.create;
export const createSessionId = SessionId.create;
export const createTokenId = TokenId.create;
export const createCliAuthorizationId = CliAuthorizationId.create;
export const createOAuthClientId = OAuthClientId.create;
export const createOAuthAuthorizationId = OAuthAuthorizationId.create;
export const createIntegrationId = IntegrationId.create;
export const createAlertDestinationId = AlertDestinationId.create;
export const createJobId = JobId.create;
export const createRunId = RunId.create;

/** Derive a stable proposal id from an already-scoped idempotency seed. */
export async function deriveProposalId(seed: string): Promise<ProposalId> {
	const digest = new Uint8Array(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed)),
	);
	return ProposalId.parse(`prop-${bodyFromBytes(digest)}`);
}

// Event object keys use a monotonic ULID so that, even when many events are
// written within the same millisecond, the keys still sort in append order.
// Events are stored one immutable object per event under a per-day prefix.
const nextEventUlid = monotonicFactory();

export function createEventId(): string {
	return nextEventUlid();
}
