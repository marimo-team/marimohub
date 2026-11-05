import type { HostEvent, HostReply, HostRequest } from './events';
import type { HostRetryStore } from './retries';

export interface HostPrincipal {
	/** Scopes Idempotency-Keys and attributes catalog changes; never sent to clients. */
	id: string;
}

/** A protocol notebook record. The platform computes `operations` for the requesting principal. */
export interface HostNotebookRecord {
	id: string;
	project_id: string;
	path: string | null;
	name: string;
	updated_at: string;
	operations: string[];
}

/** Whatever the platform loaded to authorize a notebook, plus the record it projects to. */
export interface HostNotebookContext {
	record: HostNotebookRecord;
}

/** A running runtime the platform can reach. Platforms attach what their transport needs. */
export interface HostRuntimeHandle {
	/** The notebook this runtime serves; a temporary runtime may serve a distinct notebook ID. */
	notebookId: string;
	projectId: string;
	/** Stable per-runtime key: it prefixes runtime IDs and binds idempotent retries. */
	key: string;
}

export interface HostCatalogSnapshot {
	/** `host`, `project`, and `notebook` records visible to the principal, in that order. */
	events: HostEvent[];
}

export interface HostRuntimeDiscovery<R extends HostRuntimeHandle> {
	notebookId: string;
	projectId: string;
	key: string;
	/** Whether the principal may observe this runtime's records. */
	authorized: boolean;
	/** Present when the host can read the runtime's catalog without a client stream attached. */
	connect?: () => Promise<R>;
}

export interface HostRequestContext {
	request: Request;
	requestId: string;
	signal: AbortSignal;
}

export interface HostCreateNotebookInput {
	project_id: string;
	name: string;
	path?: string;
}

export interface HostUpdateNotebookInput {
	name?: string;
	path?: string;
}

export interface HostMutationAttempt {
	/**
	 * Call immediately before the irreversible write. A failure after dispatch keeps the key
	 * claimed because the outcome is unknown; a failure before it frees the key.
	 */
	dispatch(): Promise<void>;
}

/**
 * A notebook mutation the platform has already authorized. Authorization runs before the
 * Idempotency-Key is consulted, so a principal who lost access cannot replay a stored receipt;
 * `commit` then runs under the key's claim.
 */
export interface HostMutation {
	commit(attempt: HostMutationAttempt): Promise<HostNotebookRecord>;
}

export interface HostRuntimeStartOptions {
	decisions?: Record<string, string>;
	/** The client's Idempotency-Key, for platforms that derive their own idempotent operations. */
	key?: string;
}

export interface HostRuntimeCallOptions {
	/** Whether the call should count as client activity that keeps the runtime alive. */
	keepAlive: boolean;
}

/**
 * Everything a platform supplies to serve the host protocol. Methods throw `HostProblemError`
 * for protocol outcomes; any other error is mapped through `errorStatus`, defaulting to 500.
 */
export interface HostPlatform<
	P extends HostPrincipal,
	N extends HostNotebookContext,
	R extends HostRuntimeHandle,
	S extends HostCatalogSnapshot = HostCatalogSnapshot,
> {
	/** Called per request and again on every stream tick, so revoked credentials end streams. */
	authenticate(request: Request): Promise<P>;
	/** Once per request after authentication; streams do not repeat it. */
	onAuthenticated?(principal: P, context: HostRequestContext): Promise<void>;
	errorStatus?(error: unknown): number | undefined;
	retries: HostRetryStore;
	/** Decisions with IDs under this prefix are answered by `ensureRuntime`, not the runtime. */
	decisionPrefix?: string;

	catalog(principal: P, signal: AbortSignal): Promise<S>;
	/** A cheap change token; the catalog is recomputed when it moves or on a fixed cadence. */
	catalogVersion(principal: P): Promise<string | null>;
	/**
	 * Every running runtime in the snapshot's projects, authorized or not, so the host can retire
	 * runtime records it remembers. `visible` holds the notebook IDs in the snapshot.
	 */
	runtimes(
		principal: P,
		snapshot: S,
		visible: ReadonlySet<string>,
		signal: AbortSignal,
	): Promise<HostRuntimeDiscovery<R>[]>;

	/** Load and authorize a notebook for reading; throw not-found for IDs the principal cannot see. */
	resolveNotebook(principal: P, id: string): Promise<N>;
	createNotebook(
		principal: P,
		input: HostCreateNotebookInput,
		context: HostRequestContext,
	): Promise<HostMutation>;
	updateNotebook(
		principal: P,
		notebook: N,
		input: HostUpdateNotebookInput,
		ifMatch: string | undefined,
		context: HostRequestContext,
	): Promise<HostMutation>;

	/** Start or reuse the notebook's runtime; may throw a decision-required problem. */
	ensureRuntime(
		principal: P,
		notebook: N,
		options: HostRuntimeStartOptions,
		context: HostRequestContext,
	): Promise<R>;
	/** The notebook's running runtime, or a no-runtime problem. Never starts one. */
	existingRuntime(principal: P, notebook: N): Promise<R>;
	/** The runtime a retried request was bound to, or a no-runtime problem if it is gone. */
	runtimeByKey(principal: P, notebook: N, key: string): Promise<R>;
	callRuntime(
		principal: P,
		runtime: R,
		request: Omit<HostRequest, 'notebookPath'>,
		signal: AbortSignal | undefined,
		options: HostRuntimeCallOptions,
	): Promise<HostReply>;
}

export interface HostAppOptions {
	/** Realm in `WWW-Authenticate` challenges. */
	realm?: string;
	/** Observe failures the host answered with 5xx. */
	onError?: (error: unknown, response: Response) => void;
}
