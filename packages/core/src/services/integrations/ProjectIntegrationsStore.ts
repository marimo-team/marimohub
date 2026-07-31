import { all } from 'better-all';
import { mapWithConcurrency } from '../../concurrency';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';
import {
	assertVersionMatch,
	BadRequestError,
	NotFoundError,
	PreconditionFailedError,
	ValidationError,
} from '../../errors';
import type { IntegrationId, ProjectId, UserId } from '../../ids';
import { createIntegrationId } from '../../ids';
import { paths } from '../../paths';
import type { Bucket } from '../../ports/bucket';
import { noopMetrics } from '../../ports/metrics';
import type { Metrics } from '../../ports/metrics';
import type {
	CreateIntegrationInput,
	IntegrationDetail,
	IntegrationEntry,
	IntegrationProbe,
	IntegrationsProvider,
	IntegrationVersionPage,
	IntegrationVersionPageRequest,
	KindDescriptor,
	SessionRender,
	SessionRenderContext,
	TestIntegrationRequest,
	TestResult,
	UpdateIntegrationInput,
} from '../../ports/integrations';
import type { ManagedSecretCodec } from '../../ports/secrets';
import { metricsObserver, saga } from '../../saga';
import {
	CURRENT_INTEGRATION_CONFIG_VERSION,
	IntegrationRecordSchema,
	IntegrationVersionRecordSchema,
	parseStored,
} from '../../schema';
import type { IntegrationRecord, IntegrationVersionRecord } from '../../schema';
import { listAllObjects } from '../catalog/storage';
import {
	acquireSingletonClaim,
	mutateObject,
	releaseSingletonClaim,
	withCasRetry,
} from '../catalog/cas';
import { assertValidIntegrationName, bundleIntegrations } from './bundle';
import type { RenderedIntegration } from './bundle';
import type { IntegrationRegistry } from './registry';
import {
	findStraySecretBoxes,
	openConfig,
	redactConfig,
	sealConfig,
	validateStoredConfig,
} from './secretFields';
import type { StoredSecretValue } from './secretFields';
import type { IntegrationDefinition } from './sdk';

/** Page size when a caller states none; the API passes its own page policy. */
const DEFAULT_VERSION_PAGE_SIZE = 100;

/**
 * A head that no longer matches the caller's `If-Match`, raised from inside a CAS
 * callback. `withCasRetry` reads a `PreconditionFailedError` as a lost race and
 * retries it, so the guard escapes the loop wrapped and `update` rethrows the 412.
 */
class StaleHeadError extends Error {
	constructor(readonly precondition: PreconditionFailedError) {
		super(precondition.message);
		this.name = 'StaleHeadError';
	}
}

function assertHeadUnchanged(current: IntegrationRecord, expected: string | undefined): void {
	try {
		assertVersionMatch(current.updated_at, expected);
	} catch (err) {
		if (err instanceof PreconditionFailedError) throw new StaleHeadError(err);
		throw err;
	}
}

/**
 * A head carrying `deleted_at` is a tombstone: the terminal state a delete CAS's
 * it into before sweeping the objects. The bucket port has no conditional
 * delete, so that CAS is the atomic commit point a delete and a concurrent
 * update race on. A tombstoned head reads as absent everywhere, so a delete
 * interrupted before its sweep leaves the integration gone rather than
 * half-visible, and the next delete resumes it.
 */
function isTombstoned(raw: unknown): boolean {
	return typeof (raw as { deleted_at?: unknown } | null)?.deleted_at === 'string';
}

function versionFromKey(key: string): number {
	const match = /^(\d+)\.json$/.exec(key.slice(key.lastIndexOf('/') + 1));
	if (!match) throw new ValidationError(`Invalid integration version key "${key}".`);
	return Number(match[1]);
}

/** Opaque keyset cursor: the last version number selected for the page. */
function encodeVersionCursor(version: number): string {
	return btoa(String(version));
}

function decodeVersionCursor(cursor: string | undefined): number | undefined {
	if (cursor === undefined || cursor === '') return undefined;
	let version: number | undefined;
	try {
		version = Number(atob(cursor));
	} catch {
		version = undefined;
	}
	if (version === undefined || !Number.isInteger(version) || version < 1) {
		throw new BadRequestError('Invalid pagination cursor');
	}
	return version;
}

export interface ProjectIntegrationsStoreOptions {
	bucket: Bucket;
	registry: IntegrationRegistry;
	/** Shared managed-secret codec; absence disables secret-bearing configs. */
	codec?: ManagedSecretCodec;
	/**
	 * The only network path exposed to kind probes; implementations enforce egress policy.
	 */
	probe?: IntegrationProbe;
	/** Injectable clock for deterministic tests. */
	now?: () => string;
	metrics?: Metrics;
}

export class ProjectIntegrationsStore implements IntegrationsProvider {
	private readonly bucket: Bucket;
	private readonly registry: IntegrationRegistry;
	private readonly codec?: ManagedSecretCodec;
	private readonly probe?: IntegrationProbe;
	private readonly now: () => string;
	private readonly metrics: Metrics;

	constructor(options: ProjectIntegrationsStoreOptions) {
		this.bucket = options.bucket;
		this.registry = options.registry;
		this.codec = options.codec;
		this.probe = options.probe;
		this.now = options.now ?? (() => new Date().toISOString());
		this.metrics = options.metrics ?? noopMetrics;
	}

	listKinds(): KindDescriptor[] {
		// A deployment without a guarded probe must not advertise the Test action.
		const testable = this.probe !== undefined;
		return this.registry.describeAll().map((d) => (testable ? d : { ...d, supports_test: false }));
	}

	async list(projectId: ProjectId): Promise<IntegrationEntry[]> {
		const heads = await this.listHeads(projectId);
		return heads.map(toEntry).sort((a, b) => a.name.localeCompare(b.name));
	}

	async get(projectId: ProjectId, id: IntegrationId): Promise<IntegrationDetail> {
		const head = await this.getHead(projectId, id);
		const { version, config } = await this.loadCurrent(projectId, head);
		return this.toDetail(head, version, config);
	}

	async create(
		projectId: ProjectId,
		input: CreateIntegrationInput,
		actor: UserId,
	): Promise<IntegrationDetail> {
		const def = this.registry.get(input.kind);
		assertValidIntegrationName(input.name);
		await this.assertNameFree(projectId, input.name);

		const id = createIntegrationId();
		const config = await this.seal(projectId, id, def, input.config);
		const timestamp = this.now();
		const version: IntegrationVersionRecord = {
			schema_version: CURRENT_INTEGRATION_CONFIG_VERSION,
			version: 1,
			kind: def.kind,
			kind_schema_version: def.schemaVersion,
			config,
			created_by: actor,
			created_at: timestamp,
			...(input.change_note ? { change_note: input.change_note } : {}),
		};
		const head: IntegrationRecord = {
			id,
			project_id: projectId,
			kind: def.kind,
			name: input.name,
			enabled: true,
			current_version: 1,
			created_by: actor,
			created_at: timestamp,
			updated_at: timestamp,
		};
		const integrationPaths = paths.project(projectId).integration(id);
		const versionPath = integrationPaths.version(1);
		// Claimed AFTER the head exists so a rival's `isHolderLive` probe can see it;
		// the claim key is the atomic arbiter two concurrent creates race on. The
		// loser removes its own just-written objects.
		await saga(metricsObserver(this.metrics, 'saga.integration_create'))
			.step('write_version', {
				do: () =>
					this.bucket.put(versionPath, JSON.stringify(version), {
						onlyIfNotExists: true,
					}),
				compensate: () => this.bucket.delete(versionPath),
			})
			.step('write_head', {
				do: () =>
					this.bucket.put(integrationPaths.head, JSON.stringify(head), {
						onlyIfNotExists: true,
					}),
				compensate: () => this.bucket.delete(integrationPaths.head),
			})
			.step('claim_name', () => this.claimName(projectId, input.name, id))
			.run();
		return this.toDetail(head, version, config);
	}

	async update(
		projectId: ProjectId,
		id: IntegrationId,
		input: UpdateIntegrationInput,
		actor: UserId,
		expectedVersion?: string,
	): Promise<IntegrationDetail> {
		const head = await this.getHead(projectId, id);
		assertVersionMatch(head.updated_at, expectedVersion);
		const headPath = paths.project(projectId).integration(id).head;
		// Re-checked at every CAS, not just the read above: a delete that commits its
		// tombstone underneath this PATCH must fail it (and compensate) rather than
		// write to a head that is already gone.
		const parseHead = (raw: unknown) => this.parseHead(projectId, id, raw);
		const headNotFound = { notFound: () => new NotFoundError(`Integration ${id} not found`) };
		const newName = input.name !== undefined && input.name !== head.name ? input.name : undefined;
		if (newName !== undefined) {
			assertValidIntegrationName(newName);
		}

		// Validation + encryption run BEFORE any visible write, so the common
		// failure modes (invalid config, missing KEK, unknown kind) cannot leave a
		// half-applied PATCH — e.g. a committed rename with a rejected config.
		const { sealed } = await all({
			nameAvailable: async () => {
				if (newName !== undefined) await this.assertNameFree(projectId, newName);
			},
			sealed: async () => {
				if (input.config === undefined) return;
				const previous = await this.loadCurrent(projectId, head);
				return {
					def: previous.def,
					config: await this.seal(projectId, id, previous.def, input.config, previous.config),
				};
			},
		});

		let appended: number | undefined;
		let updated: IntegrationRecord | undefined;
		// The version each head CAS must still observe. The early check above only
		// covers the read; a CAS attempt (including a retry after a lost race) can
		// see a newer head, and applying its mutation there would silently overwrite
		// an edit the caller never read. It advances past this PATCH's own rename.
		let expected = expectedVersion;
		const transaction = saga(metricsObserver(this.metrics, 'saga.integration_update'));
		if (newName !== undefined) {
			transaction
				.step('rename_head', {
					do: async () => {
						const renamed = await mutateObject(
							this.bucket,
							headPath,
							parseHead,
							(current) => {
								assertHeadUnchanged(current, expected);
								return {
									...current,
									name: newName,
									updated_at: nextTimestamp(current.updated_at, this.now()),
								};
							},
							headNotFound,
						);
						// Only under a precondition: adopting it unguarded would turn an
						// ordinary PATCH's later CAS into a 412 on any concurrent write.
						if (expected !== undefined) expected = renamed.updated_at;
					},
					compensate: () => this.revertRename(projectId, id, newName, head.name),
				})
				.step('claim_name', {
					do: () => this.claimName(projectId, newName, id),
					compensate: () => this.releaseName(projectId, newName, id),
				});
		}
		if (sealed) {
			transaction.step('append_version', {
				do: async () => {
					appended = await this.appendVersion(projectId, head, {
						schema_version: CURRENT_INTEGRATION_CONFIG_VERSION,
						kind: sealed.def.kind,
						kind_schema_version: sealed.def.schemaVersion,
						config: sealed.config,
						created_by: actor,
						created_at: this.now(),
						...(input.change_note ? { change_note: input.change_note } : {}),
					});
				},
				compensate: async () => {
					if (appended !== undefined) {
						await this.bucket.delete(paths.project(projectId).integration(id).version(appended));
					}
				},
			});
		}
		transaction.step('commit_head', async () => {
			updated = await mutateObject(
				this.bucket,
				headPath,
				parseHead,
				(current) => {
					assertHeadUnchanged(current, expected);
					return {
						...current,
						...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
						// Two concurrent config edits both land in history; the higher version
						// number wins the pointer regardless of head-commit order.
						...(appended !== undefined
							? { current_version: Math.max(current.current_version, appended) }
							: {}),
						updated_at: nextTimestamp(current.updated_at, this.now()),
					};
				},
				headNotFound,
			);
		});
		try {
			await transaction.run();
		} catch (err) {
			if (err instanceof StaleHeadError) throw err.precondition;
			throw err;
		}
		if (newName !== undefined) await this.releaseName(projectId, head.name, id);
		const { version, config } = await this.loadCurrent(projectId, updated!);
		return this.toDetail(updated!, version, config);
	}

	/**
	 * Undo a head rename — a no-op if a third writer renamed again in between, or
	 * if a delete tombstoned the head: that CAS is the commit point, so writing a
	 * name back onto it would edit an integration already gone.
	 */
	private async revertRename(
		projectId: ProjectId,
		id: IntegrationId,
		fromName: string,
		toName: string,
	): Promise<void> {
		await mutateObject(
			this.bucket,
			paths.project(projectId).integration(id).head,
			(raw) => parseStored(IntegrationRecordSchema, raw, `integration ${id}`),
			(current) =>
				current.name === fromName && !isTombstoned(current) ? { ...current, name: toName } : null,
			{ notFound: () => new NotFoundError(`Integration ${id} not found`) },
		);
	}

	/**
	 * Commits by CAS'ing the head to a tombstone, then sweeps the objects. The CAS,
	 * not the read that precedes it, is what enforces `expectedVersion`: an update
	 * committing in that window takes the head's ETag with it, and the retry
	 * re-checks the token against the winner, so a stale `If-Match` answers 412
	 * instead of erasing an edit the caller never saw.
	 */
	async delete(projectId: ProjectId, id: IntegrationId, expectedVersion?: string): Promise<void> {
		const integrationPaths = paths.project(projectId).integration(id);
		let name: string | undefined;
		try {
			name = await this.tombstoneHead(projectId, id, expectedVersion);
		} catch (err) {
			if (err instanceof StaleHeadError) throw err.precondition;
			// A head that cannot be parsed has no version to check and nothing to
			// tombstone, but must still be removable — sweep its objects unguarded.
			if (!(err instanceof ValidationError)) throw err;
		}
		const strays = (await listAllObjects(this.bucket, integrationPaths.base))
			.map((o) => o.key)
			.filter((key) => key !== integrationPaths.head);
		if (strays.length > 0) await this.bucket.delete(strays);
		// The tombstone goes LAST: while it stands, the integration reads as gone and
		// a delete interrupted mid-sweep still resumes. Dropping it first would leave
		// the surviving objects in a directory no listing reports, so nothing would
		// ever reclaim them.
		await this.bucket.delete(integrationPaths.head);
		if (name !== undefined) await this.releaseName(projectId, name, id);
	}

	/**
	 * Returns the name whose claim the delete must release, or undefined when there
	 * is no head left to tombstone.
	 */
	private async tombstoneHead(
		projectId: ProjectId,
		id: IntegrationId,
		expectedVersion: string | undefined,
	): Promise<string | undefined> {
		const headPath = paths.project(projectId).integration(id).head;
		return withCasRetry(async () => {
			const existing = await this.bucket.get(headPath);
			if (!existing) return;
			const raw = await existing.json();
			// Already committed by an interrupted delete: resume its sweep (and its
			// name release) rather than answer 412 on a token no live head can match.
			if (isTombstoned(raw)) {
				return parseStored(IntegrationRecordSchema, raw, `integration ${id}`).name;
			}
			const head = this.parseHead(projectId, id, raw);
			assertHeadUnchanged(head, expectedVersion);
			await this.bucket.put(headPath, JSON.stringify({ ...head, deleted_at: this.now() }), {
				onlyIfEtagMatches: existing.etag,
			});
			return head.name;
		});
	}

	async listVersions(
		projectId: ProjectId,
		id: IntegrationId,
		page: IntegrationVersionPageRequest = { limit: DEFAULT_VERSION_PAGE_SIZE },
	): Promise<IntegrationVersionPage> {
		const head = await this.getHead(projectId, id);
		const objects = await listAllObjects(
			this.bucket,
			paths.project(projectId).integration(id).versionsPrefix,
		);
		// The key carries the version number, so the page is chosen from the listing
		// alone and only its records are read — history is append-only and unbounded,
		// and every record carries a full config blob.
		const after = decodeVersionCursor(page.cursor);
		const remaining = objects
			.map((o) => ({ key: o.key, version: versionFromKey(o.key) }))
			.filter((o) => after === undefined || o.version < after)
			.sort((a, b) => b.version - a.version);
		const selected = remaining.slice(0, Math.max(page.limit, 1));
		const records = await mapWithConcurrency(selected, BUCKET_SCAN_CONCURRENCY, async (o) => {
			const body = await this.bucket.get(o.key);
			if (!body) return null;
			const record = parseStored(IntegrationVersionRecordSchema, await body.json(), o.key);
			this.assertVersionIdentity(head, o.version, record, o.key);
			return record;
		});
		const last = selected[selected.length - 1];
		return {
			items: records
				.filter((r) => r !== null)
				.sort((a, b) => b.version - a.version)
				.map((r) => ({
					version: r.version,
					kind_schema_version: r.kind_schema_version,
					created_by: r.created_by,
					created_at: r.created_at,
					...(r.change_note ? { change_note: r.change_note } : {}),
				})),
			// Keyed off the last selected KEY, not the last returned record, so a
			// version deleted underneath us cannot truncate the history early.
			next_cursor:
				last && remaining.length > selected.length ? encodeVersionCursor(last.version) : null,
		};
	}

	async test(projectId: ProjectId, request: TestIntegrationRequest): Promise<TestResult> {
		let def: IntegrationDefinition;
		let resolved: Record<string, unknown>;
		if ('id' in request) {
			const head = await this.getHead(projectId, request.id);
			const current = await this.loadCurrent(projectId, head);
			def = current.def;
			resolved = await this.open(projectId, head.id, def, current.config);
		} else {
			def = this.registry.get(request.kind);
			// Run unsaved configs through the stored-config path without touching the bucket.
			const transient = transientSealer();
			const stored = await sealConfig({
				schema: def.configSchema,
				paths: this.registry.secretPathsOf(def.kind),
				authoring: request.config,
				seal: transient,
				check: def.validate?.bind(def),
			});
			resolved = await openConfig({
				stored,
				paths: this.registry.secretPathsOf(def.kind),
				open: transient,
			});
		}
		if (!def.testConnection) {
			throw new ValidationError(`Integration kind "${def.kind}" does not support testing.`);
		}
		const probe = this.probe;
		if (!probe) {
			throw new ValidationError('Connection testing is not enabled on this deployment.');
		}
		const parsed = def.configSchema.parse(resolved);
		return def.testConnection(parsed, probe);
	}

	async resolveForSession(
		projectId: ProjectId,
		context: SessionRenderContext,
	): Promise<SessionRender | undefined> {
		const heads = (await this.listHeads(projectId))
			.filter((h) => h.enabled)
			.sort((a, b) => a.name.localeCompare(b.name));
		if (heads.length === 0) return undefined;

		const rendered = await mapWithConcurrency(
			heads,
			BUCKET_SCAN_CONCURRENCY,
			async (head): Promise<RenderedIntegration> => {
				const { def, version, config } = await this.loadCurrent(projectId, head);
				const resolved = await this.open(projectId, head.id, def, config);
				const parsed = def.configSchema.safeParse(resolved);
				if (!parsed.success) {
					// Never surface the Zod issues here — the resolved config is plaintext.
					throw new ValidationError(
						`Integration "${head.name}" has a stored config that no longer matches ` +
							`kind "${head.kind}" — edit and re-save it.`,
					);
				}
				return {
					id: head.id,
					name: head.name,
					kind: head.kind,
					version: version.version,
					requirements: def.requirements,
					output: def.render({
						config: parsed.data,
						instanceName: head.name,
						projectId,
						principal: context.principal,
						session: { sessionId: context.sessionId },
					}),
				};
			},
		);
		return bundleIntegrations(rendered, context.sessionId);
	}

	private async listHeads(projectId: ProjectId): Promise<IntegrationRecord[]> {
		const prefix = paths.project(projectId).integrationsPrefix;
		const dirs: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.bucket.list({ prefix, delimiter: '/', cursor });
			dirs.push(...page.delimitedPrefixes);
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);

		const instanceDirs = dirs.filter((dir) => !dir.endsWith('/_names/'));
		const heads = await mapWithConcurrency(instanceDirs, BUCKET_SCAN_CONCURRENCY, async (dir) => {
			const body = await this.bucket.get(`${dir}integration.json`);
			if (!body) return null; // deleted between list and get — skip
			const raw = await body.json();
			if (isTombstoned(raw)) return null; // a committed delete, sweep pending
			const head = parseStored(IntegrationRecordSchema, raw, `${dir}integration.json`);
			const rawId = dir.slice(prefix.length, -1);
			if (!rawId) throw new ValidationError(`Invalid integration path "${dir}".`);
			this.assertHeadIdentity(projectId, rawId as IntegrationId, head);
			return head;
		});
		return heads.filter((h) => h !== null);
	}

	private async getHead(projectId: ProjectId, id: IntegrationId): Promise<IntegrationRecord> {
		const body = await this.bucket.get(paths.project(projectId).integration(id).head);
		if (!body) throw new NotFoundError(`Integration ${id} not found`);
		return this.parseHead(projectId, id, await body.json());
	}

	/** A tombstoned head is gone as far as every reader and writer is concerned. */
	private parseHead(projectId: ProjectId, id: IntegrationId, raw: unknown): IntegrationRecord {
		if (isTombstoned(raw)) throw new NotFoundError(`Integration ${id} not found`);
		const head = parseStored(IntegrationRecordSchema, raw, `integration ${id}`);
		this.assertHeadIdentity(projectId, id, head);
		return head;
	}

	private async getVersion(
		projectId: ProjectId,
		head: IntegrationRecord,
		version: number,
	): Promise<IntegrationVersionRecord> {
		const key = paths.project(projectId).integration(head.id).version(version);
		const body = await this.bucket.get(key);
		if (!body) throw new NotFoundError(`Integration ${head.id} version ${version} not found`);
		const record = parseStored(IntegrationVersionRecordSchema, await body.json(), key);
		// The record ENVELOPE version (distinct from the kind's schemaVersion):
		// interpreting a newer envelope with these semantics could mis-handle
		// fields it added. Older envelopes route through an upgrade seam here once
		// a v2 exists; v1 is the only shape so far.
		if (record.schema_version > CURRENT_INTEGRATION_CONFIG_VERSION) {
			throw new ValidationError(
				`Integration "${head.name}" version ${version} was written by a newer deployment ` +
					`(record schema v${record.schema_version}) and cannot be read here.`,
			);
		}
		this.assertVersionIdentity(head, version, record, key);
		return record;
	}

	private assertHeadIdentity(
		projectId: ProjectId,
		id: IntegrationId,
		head: IntegrationRecord,
	): void {
		if (head.id !== id || head.project_id !== projectId) {
			throw new ValidationError(
				`Integration ${id} metadata does not match its project storage path.`,
			);
		}
		assertValidIntegrationName(head.name);
	}

	private assertVersionIdentity(
		head: IntegrationRecord,
		expectedVersion: number,
		record: IntegrationVersionRecord,
		key: string,
	): void {
		if (record.version !== expectedVersion || record.kind !== head.kind) {
			throw new ValidationError(
				`Integration "${head.name}" version metadata does not match "${key}".`,
			);
		}
	}

	/** Appends create-if-absent; concurrent writers retry at the next version. */
	private async appendVersion(
		projectId: ProjectId,
		head: IntegrationRecord,
		record: Omit<IntegrationVersionRecord, 'version'>,
	): Promise<number> {
		let version = head.current_version + 1;
		const integrationPaths = paths.project(projectId).integration(head.id);
		return withCasRetry(async () => {
			try {
				await this.bucket.put(
					integrationPaths.version(version),
					JSON.stringify({ ...record, version }),
					{
						onlyIfNotExists: true,
					},
				);
				return version;
			} catch (err) {
				if (err instanceof PreconditionFailedError) version += 1;
				throw err;
			}
		});
	}

	private async assertNameFree(projectId: ProjectId, name: string): Promise<void> {
		const heads = await this.listHeads(projectId);
		if (heads.some((h) => h.name === name)) {
			throw new ValidationError(`An integration named "${name}" already exists in this project.`);
		}
	}

	private nameClaimConfig(projectId: ProjectId, name: string) {
		return {
			bucket: this.bucket,
			key: paths.project(projectId).integrationNameClaim(name),
			serialize: (holder: string | null) =>
				JSON.stringify({ integration_id: holder, claimed_at: this.now() }),
			parseHolder: (raw: unknown): string | null => {
				const holder = (raw as { integration_id?: unknown }).integration_id;
				return typeof holder === 'string' ? holder : null;
			},
		};
	}

	// The claim is the atomic name arbiter; the earlier listing check is only a fast path.
	private async claimName(projectId: ProjectId, name: string, id: IntegrationId): Promise<void> {
		const claim = await acquireSingletonClaim(
			{
				...this.nameClaimConfig(projectId, name),
				isHolderLive: async (holder) => {
					try {
						return (await this.getHead(projectId, holder as IntegrationId)).name === name;
					} catch {
						return false;
					}
				},
			},
			id,
		);
		if (!claim.acquired) {
			throw new ValidationError(`An integration named "${name}" already exists in this project.`);
		}
	}

	private async releaseName(projectId: ProjectId, name: string, id: IntegrationId): Promise<void> {
		await releaseSingletonClaim(this.nameClaimConfig(projectId, name), id);
	}

	private async loadCurrent(
		projectId: ProjectId,
		head: IntegrationRecord,
	): Promise<{
		def: IntegrationDefinition;
		version: IntegrationVersionRecord;
		config: Record<string, unknown>;
	}> {
		const def = this.registry.get(head.kind);
		const version = await this.getVersion(projectId, head, head.current_version);
		const config = this.migrated(head.name, def, version);
		// A secret box outside the kind's registered paths (e.g. a migration that
		// left a renamed field behind) would dodge redaction and leak ciphertext —
		// refuse the whole config instead.
		const strays = findStraySecretBoxes(config, this.registry.secretPathsOf(head.kind));
		if (strays.length > 0) {
			throw new ValidationError(
				`Integration "${head.name}" holds secret data at unregistered path(s) ` +
					`${strays.join(', ')} — its stored config does not match kind "${head.kind}". ` +
					'Edit and re-save it.',
			);
		}
		try {
			validateStoredConfig({
				schema: def.configSchema,
				paths: this.registry.secretPathsOf(head.kind),
				stored: config,
				check: def.validate?.bind(def),
			});
		} catch (err) {
			if (!(err instanceof ValidationError)) throw err;
			throw new ValidationError(
				`Integration "${head.name}" has a stored config that no longer matches ` +
					`kind "${head.kind}" — edit and re-save it.`,
			);
		}
		return { def, version, config };
	}

	/** Migrates a stored config through each missing kind schema version. */
	private migrated(
		name: string,
		def: IntegrationDefinition,
		record: IntegrationVersionRecord,
	): Record<string, unknown> {
		if (record.kind_schema_version > def.schemaVersion) {
			// A newer deployment wrote this shape; guessing at its semantics (or
			// stripping fields it added) is worse than refusing.
			throw new ValidationError(
				`Integration "${name}" was saved with ${def.kind} schema ` +
					`v${record.kind_schema_version}, newer than this deployment's v${def.schemaVersion}.`,
			);
		}
		if (record.kind_schema_version === def.schemaVersion) return record.config;
		if (!def.migrate) {
			throw new ValidationError(
				`Integration "${name}" was saved with ${def.kind} schema v${record.kind_schema_version}, ` +
					`but this deployment's v${def.schemaVersion} has no migration path — re-save it.`,
			);
		}
		let config: unknown = record.config;
		for (let from = record.kind_schema_version; from < def.schemaVersion; from++) {
			config = def.migrate(config, from);
		}
		return config as Record<string, unknown>;
	}

	private async seal(
		projectId: ProjectId,
		id: IntegrationId,
		def: IntegrationDefinition,
		authoring: Record<string, unknown>,
		previous?: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const codec = this.codec;
		const contextFor = this.secretContext(projectId, id);
		return sealConfig({
			schema: def.configSchema,
			paths: this.registry.secretPathsOf(def.kind),
			authoring,
			previous,
			check: def.validate?.bind(def),
			seal: {
				encrypt: async (plaintext, at): Promise<StoredSecretValue> => {
					if (!codec) {
						throw new ValidationError(
							'This integration has secret fields, but managed secrets are not ' +
								'configured on this deployment (set MARIMOHUB_SECRETS_KEK).',
						);
					}
					const envelope = await codec.encrypt(plaintext, { path: contextFor(at) });
					return { $secret: { kind: 'managed', envelope } };
				},
			},
		});
	}

	private async open(
		projectId: ProjectId,
		id: IntegrationId,
		def: IntegrationDefinition,
		stored: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const codec = this.codec;
		const contextFor = this.secretContext(projectId, id);
		return openConfig({
			stored,
			paths: this.registry.secretPathsOf(def.kind),
			open: {
				decrypt: (envelope, at) => {
					if (!codec) {
						throw new ValidationError(
							'Cannot resolve secret fields: managed secrets are not configured ' +
								'on this deployment (set MARIMOHUB_SECRETS_KEK).',
						);
					}
					return codec.decrypt(envelope, { path: contextFor(at) });
				},
			},
		});
	}

	/**
	 * Encryption context: head path + wildcard field path. Stable across version
	 * bumps and array reorders (never a concrete index or version number), unique
	 * per integration + field class — a leaked envelope cannot be replayed
	 * elsewhere.
	 */
	private secretContext(projectId: ProjectId, id: IntegrationId): (at: string) => string {
		const base = paths.project(projectId).integration(id).head;
		return (at) => `${base}#${at}`;
	}

	/** `config` must be the MIGRATED stored config (see `loadCurrent`), so the
	 *  current kind's secret paths line up and redaction cannot miss a moved field. */
	private toDetail(
		head: IntegrationRecord,
		version: IntegrationVersionRecord,
		config: Record<string, unknown>,
	): IntegrationDetail {
		return {
			...toEntry(head),
			config: redactConfig(config, this.registry.secretPathsOf(head.kind)),
			...(version.change_note ? { change_note: version.change_note } : {}),
		};
	}
}

function toEntry(head: IntegrationRecord): IntegrationEntry {
	return {
		id: head.id,
		kind: head.kind,
		name: head.name,
		enabled: head.enabled,
		current_version: head.current_version,
		created_by: head.created_by,
		created_at: head.created_at,
		updated_at: head.updated_at,
	};
}

function nextTimestamp(current: string, candidate: string): string {
	const currentMs = Date.parse(current);
	const candidateMs = Date.parse(candidate);
	return candidateMs > currentMs ? candidate : new Date(currentMs + 1).toISOString();
}

/** In-memory seal/open pair used to validate unsaved configs. */
function transientSealer() {
	const values = new Map<string, string>();
	return {
		encrypt: (plaintext: string): Promise<StoredSecretValue> => {
			const ref = `transient-${values.size}`;
			values.set(ref, plaintext);
			return Promise.resolve({
				$secret: {
					kind: 'managed' as const,
					envelope: { kek_id: ref, alg: 'A256GCM' as const, iv: '', ciphertext: '' },
				},
			});
		},
		decrypt: (envelope: { kek_id: string }): Promise<string> => {
			const value = values.get(envelope.kek_id);
			if (value === undefined) {
				return Promise.reject(new ValidationError('Unknown transient secret reference.'));
			}
			return Promise.resolve(value);
		},
	};
}
