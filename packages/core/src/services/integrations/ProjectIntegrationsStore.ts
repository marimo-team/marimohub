import { all } from 'better-all';
import { mapWithConcurrency } from '../../concurrency';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';
import {
	assertVersionMatch,
	BadRequestError,
	NotFoundError,
	ResourceExhaustedError,
	UnavailableError,
	ValidationError,
} from '../../errors';
import type { IntegrationId, ProjectId, UserId } from '../../ids';
import { createIntegrationId } from '../../ids';
import { paths } from '../../paths';
import type { IntegrationPaths } from '../../paths';
import { logOperationalError } from '../../operationalLog';
import type { Bucket } from '../../ports/bucket';
import { noopMetrics } from '../../ports/metrics';
import type { Metrics } from '../../ports/metrics';
import type {
	CopyIntegrationOptions,
	CreateIntegrationInput,
	IntegrationDetail,
	IntegrationEntry,
	IntegrationProbe,
	IntegrationVersionMeta,
	IntegrationVersionPage,
	IntegrationVersionPageRequest,
	IntegrationSecretSources,
	KindDescriptor,
	SessionRender,
	SessionRenderContext,
	TestIntegrationRequest,
	TestResult,
	UpdateIntegrationInput,
} from '../../ports/integrations';
import type { ManagedSecretCodec, SecretRef, SecretResolver } from '../../ports/secrets';
import { SecretResolutionError } from '../../ports/secrets';
import { metricsObserver, saga } from '../../saga';
import {
	CURRENT_INTEGRATION_CONFIG_VERSION,
	IntegrationRecordSchema,
	IntegrationVersionRecordSchema,
	parseStored,
	readStored,
	readStoredJson,
	StoredObjectError,
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
	configForCopy,
	openConfig,
	redactConfig,
	sealConfig,
	validateStoredConfig,
} from './secretFields';
import type { StoredSecretValue } from './secretFields';
import type { IntegrationDefinition } from './sdk';
import type { OrgIntegrationsService, ProjectIntegrationsService } from './contracts';

/** Page size when a caller states none; the API passes its own page policy. */
const DEFAULT_VERSION_PAGE_SIZE = 100;

/** Bounds list scans and session rendering for one integration tier. */
export const MAX_INTEGRATIONS_PER_SCOPE = 500;

/**
 * Version numbers a page may probe beyond its `limit` before it stops short and
 * hands back a cursor. Gaps exist only where an update's appended version was
 * compensated away, so they are isolated and this slack hides them; the cap is
 * what keeps one page from degenerating into a full-history scan if that ever
 * stops holding.
 */
const VERSION_PROBE_SLACK = 32;

/**
 * Storage location of one integration tier. The machinery below is identical
 * for both tiers; a scope pins where instances live, what `project_id` a head
 * must carry (absent for the org tier), and how errors name the tier.
 */
interface IntegrationScope {
	integration: (id: IntegrationId) => IntegrationPaths;
	prefix: string;
	nameClaim: (name: string) => string;
	/** Stamped on and required of every head in the scope; absent for org. */
	projectId?: ProjectId;
	/** Locates the scope in user-facing errors, e.g. "in this project". */
	where: string;
}

function projectScope(projectId: ProjectId): IntegrationScope {
	const project = paths.project(projectId);
	return {
		integration: project.integration,
		prefix: project.integrationsPrefix,
		nameClaim: project.integrationNameClaim,
		projectId,
		where: 'in this project',
	};
}

const ORG_SCOPE: IntegrationScope = {
	integration: paths.orgIntegration,
	prefix: paths.orgIntegrationsPrefix,
	nameClaim: paths.orgIntegrationNameClaim,
	where: 'at the org level',
};

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

/** Opaque keyset cursor: the last version number examined for the page. */
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
	// SAFE integer, not merely integer: `1e300` is an integer that `- 1` leaves
	// unchanged and `encodeVersionCursor` round-trips, so a page built from it can
	// neither make progress nor terminate.
	if (version === undefined || !Number.isSafeInteger(version) || version < 1) {
		throw new BadRequestError('Invalid pagination cursor');
	}
	return version;
}

export interface IntegrationsStoreOptions {
	bucket: Bucket;
	registry: IntegrationRegistry;
	/** Shared managed-secret codec; absence disables inline secret values. */
	codec?: ManagedSecretCodec;
	resolvers?: SecretResolver[];
	/**
	 * The only network path exposed to kind probes; implementations enforce egress policy.
	 */
	probe?: IntegrationProbe;
	/** Injectable clock for deterministic tests. */
	now?: () => string;
	metrics?: Metrics;
}

/**
 * Scope-generic machinery shared by the project and org tiers. Not exported:
 * consumers use the tier facades below, which pin the scope.
 */
class ScopedIntegrationsStore {
	private readonly bucket: Bucket;
	private readonly registry: IntegrationRegistry;
	private readonly codec?: ManagedSecretCodec;
	private readonly resolvers: Map<string, SecretResolver>;
	private readonly probe?: IntegrationProbe;
	private readonly now: () => string;
	private readonly metrics: Metrics;

	constructor(options: IntegrationsStoreOptions) {
		this.bucket = options.bucket;
		this.registry = options.registry;
		this.codec = options.codec;
		this.resolvers = new Map(
			(options.resolvers ?? []).map((resolver) => [resolver.backend, resolver]),
		);
		this.probe = options.probe;
		this.now = options.now ?? (() => new Date().toISOString());
		this.metrics = options.metrics ?? noopMetrics;
	}

	listKinds(): KindDescriptor[] {
		// A deployment without a guarded probe must not advertise the Test action.
		const testable = this.probe !== undefined;
		const secret_sources = this.secretSources();
		return this.registry.describeAll().map((descriptor) => ({
			...descriptor,
			supports_test: testable && descriptor.supports_test,
			secret_sources,
		}));
	}

	secretSources(): IntegrationSecretSources {
		return {
			inline: this.codec !== undefined,
			references: [...this.resolvers.values()]
				.map(({ backend, title, locatorPlaceholder, locatorHelp, docsUrl }) => ({
					backend,
					title,
					locator_placeholder: locatorPlaceholder,
					locator_help: locatorHelp,
					...(docsUrl ? { docs_url: docsUrl } : {}),
				}))
				.sort((a, b) => a.title.localeCompare(b.title)),
		};
	}

	async list(scope: IntegrationScope): Promise<IntegrationEntry[]> {
		const heads = await this.listHeads(scope);
		return heads.map((h) => toEntry(scope, h)).sort((a, b) => a.name.localeCompare(b.name));
	}

	async get(scope: IntegrationScope, id: IntegrationId): Promise<IntegrationDetail> {
		const head = await this.getHead(scope, id);
		const { version, config } = await this.loadCurrent(scope, head);
		return this.toDetail(scope, head, version, config);
	}

	async create(
		scope: IntegrationScope,
		input: CreateIntegrationInput,
		actor: UserId,
	): Promise<IntegrationDetail> {
		const def = this.registry.get(input.kind);
		assertValidIntegrationName(input.name);
		await this.assertNameFree(scope, input.name);
		if ((await this.listHeads(scope)).length >= MAX_INTEGRATIONS_PER_SCOPE) {
			throw new ResourceExhaustedError(
				`Integration limit reached ${scope.where} (${MAX_INTEGRATIONS_PER_SCOPE}).`,
			);
		}

		const id = createIntegrationId();
		const config = await this.seal(scope, id, def, input.config);
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
			...(scope.projectId !== undefined ? { project_id: scope.projectId } : {}),
			kind: def.kind,
			name: input.name,
			enabled: true,
			current_version: 1,
			created_by: actor,
			created_at: timestamp,
			updated_at: timestamp,
		};
		const integrationPaths = scope.integration(id);
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
			.step('claim_name', () => this.claimName(scope, input.name, id))
			.run();
		return this.toDetail(scope, head, version, config);
	}

	async update(
		scope: IntegrationScope,
		id: IntegrationId,
		input: UpdateIntegrationInput,
		actor: UserId,
		expectedVersion?: string,
	): Promise<IntegrationDetail> {
		const head = await this.getHead(scope, id);
		assertVersionMatch(head.updated_at, expectedVersion);
		const headPath = scope.integration(id).head;
		// Re-checked at every CAS, not just the read above: a delete that commits its
		// tombstone underneath this PATCH must fail it (and compensate) rather than
		// write to a head that is already gone.
		const parseHead = (raw: unknown) => this.parseHead(scope, id, raw);
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
				if (newName !== undefined) await this.assertNameFree(scope, newName);
			},
			sealed: async () => {
				if (input.config === undefined) return;
				const previous = await this.loadCurrent(scope, head);
				return {
					def: previous.def,
					config: await this.seal(scope, id, previous.def, input.config, previous.config),
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
								assertVersionMatch(current.updated_at, expected);
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
					compensate: () => this.revertRename(scope, id, newName, head.name),
				})
				.step('claim_name', {
					do: () => this.claimName(scope, newName, id),
					compensate: () => this.releaseName(scope, newName, id),
				});
		}
		if (sealed) {
			transaction.step('append_version', {
				do: async () => {
					appended = await this.appendVersion(scope, head, {
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
						await this.bucket.delete(scope.integration(id).version(appended));
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
					assertVersionMatch(current.updated_at, expected);
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
		await transaction.run();
		if (newName !== undefined) await this.releaseName(scope, head.name, id);
		const { version, config } = await this.loadCurrent(scope, updated!);
		return this.toDetail(scope, updated!, version, config);
	}

	/**
	 * Undo a head rename — a no-op if a third writer renamed again in between, or
	 * if a delete tombstoned the head: that CAS is the commit point, so writing a
	 * name back onto it would edit an integration already gone.
	 *
	 * The revert advances `updated_at` rather than restoring the pre-rename one:
	 * the rename was a committed, readable state, so a token minted from it must
	 * stop matching once the name moves back. Rewinding the token instead would
	 * both validate that stale read and discard the version of any writer that
	 * committed between the two CASes.
	 */
	private async revertRename(
		scope: IntegrationScope,
		id: IntegrationId,
		fromName: string,
		toName: string,
	): Promise<void> {
		await mutateObject(
			this.bucket,
			scope.integration(id).head,
			(raw) => parseStored(IntegrationRecordSchema, raw, `integration ${id}`),
			(current) =>
				current.name === fromName && !isTombstoned(current)
					? {
							...current,
							name: toName,
							updated_at: nextTimestamp(current.updated_at, this.now()),
						}
					: null,
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
	async delete(
		scope: IntegrationScope,
		id: IntegrationId,
		expectedVersion?: string,
	): Promise<boolean> {
		const integrationPaths = scope.integration(id);
		let name: string | undefined;
		// Whether a head was actually removed (or an interrupted removal resumed) —
		// an absent id (deleted earlier, or living in the OTHER tier) still succeeds
		// but must not read as a deletion, e.g. in the audit trail.
		let existed = false;
		try {
			name = await this.tombstoneHead(scope, id, expectedVersion);
			existed = name !== undefined;
		} catch (err) {
			// A head that cannot be parsed has no version to check and nothing to
			// tombstone, but must still be removable — sweep its objects unguarded.
			if (!(err instanceof ValidationError || err instanceof StoredObjectError)) throw err;
			logOperationalError(
				'corrupt_integration_head_deleted',
				{ operation: 'integration.delete', object: integrationPaths.head },
				err,
			);
			existed = true;
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
		if (name !== undefined) await this.releaseName(scope, name, id);
		return existed;
	}

	/**
	 * Returns the name whose claim the delete must release, or undefined when there
	 * is no head left to tombstone.
	 */
	private async tombstoneHead(
		scope: IntegrationScope,
		id: IntegrationId,
		expectedVersion: string | undefined,
	): Promise<string | undefined> {
		const headPath = scope.integration(id).head;
		return withCasRetry(this.bucket, async (cas) => {
			const existing = await this.bucket.get(headPath);
			if (!existing) return;
			const raw = await readStoredJson(existing, headPath);
			// Already committed by an interrupted delete: resume its sweep (and its
			// name release) rather than answer 412 on a token no live head can match.
			if (isTombstoned(raw)) {
				return parseStored(IntegrationRecordSchema, raw, `integration ${id}`).name;
			}
			const head = this.parseHead(scope, id, raw);
			assertVersionMatch(head.updated_at, expectedVersion);
			await cas.put(headPath, JSON.stringify({ ...head, deleted_at: this.now() }), {
				onlyIfEtagMatches: existing.etag,
			});
			return head.name;
		});
	}

	async listVersions(
		scope: IntegrationScope,
		id: IntegrationId,
		page: IntegrationVersionPageRequest = { limit: DEFAULT_VERSION_PAGE_SIZE },
	): Promise<IntegrationVersionPage> {
		const head = await this.getHead(scope, id);
		const integrationPaths = scope.integration(id);
		const after = decodeVersionCursor(page.cursor);
		// `current_version` only ever grows, so every cursor this store mints is at
		// or below the head it is read against; one above it is forged (or belongs
		// to another integration). Paging from there would return empty pages WITH a
		// cursor — no progress toward version 1, and `VERSION_PROBE_SLACK` wasted
		// reads per round-trip — so it is as malformed as an undecodable cursor.
		if (after !== undefined && after > head.current_version) {
			throw new BadRequestError('Invalid pagination cursor');
		}
		const limit = Math.max(page.limit, 1);
		// Version numbers are dense and monotonic (1…current_version, see
		// `appendVersion`), so the page's KEYS are computed from the head or the
		// cursor and only those records are read. History is append-only and
		// unbounded — listing it to find a page would make every page cost grow
		// with the history it is paging over.
		let next = after === undefined ? head.current_version : after - 1;
		let probes = limit + VERSION_PROBE_SLACK;
		const items: IntegrationVersionMeta[] = [];
		while (items.length < limit && next >= 1 && probes > 0) {
			const size = Math.min(limit - items.length, probes, next);
			const versions = Array.from({ length: size }, (_, i) => next - i);
			next -= size;
			probes -= size;
			const records = await mapWithConcurrency(
				versions,
				BUCKET_SCAN_CONCURRENCY,
				async (version) => {
					const key = integrationPaths.version(version);
					const body = await this.bucket.get(key);
					if (!body) return null;
					const record = await readStored(IntegrationVersionRecordSchema, body, key);
					this.assertVersionIdentity(head, version, record, key);
					return record;
				},
			);
			for (const record of records) {
				if (record === null) continue;
				items.push({
					version: record.version,
					kind_schema_version: record.kind_schema_version,
					created_by: record.created_by,
					created_at: record.created_at,
					...(record.change_note ? { change_note: record.change_note } : {}),
				});
			}
		}
		return {
			items,
			// Keyed off the last version NUMBER examined, not the last record
			// returned, so a version deleted underneath us cannot truncate the
			// history early.
			next_cursor: next >= 1 ? encodeVersionCursor(next + 1) : null,
		};
	}

	async copy(
		source: IntegrationScope,
		id: IntegrationId,
		target: IntegrationScope,
		options: CopyIntegrationOptions,
		actor: UserId,
	): Promise<IntegrationDetail> {
		const head = await this.getHead(source, id);
		const { def, config } = await this.loadCurrent(source, head);
		const codec = this.codec;
		const contextFor = this.secretContext(source, head.id);
		const resolved = await configForCopy({
			stored: config,
			paths: this.registry.secretPathsOf(def.kind),
			decrypt: (envelope, at) => {
				if (!codec) {
					throw new ValidationError(
						'Cannot copy inline secret fields: MARIMOHUB_SECRETS_KEK is not configured.',
					);
				}
				return codec.decrypt(envelope, { path: contextFor(at) });
			},
		});
		return this.create(
			target,
			{
				kind: head.kind,
				name: options.name ?? head.name,
				config: resolved,
				change_note: `Copied "${head.name}" from project ${source.projectId ?? 'org'}`,
			},
			actor,
		);
	}

	async test(scope: IntegrationScope, request: TestIntegrationRequest): Promise<TestResult> {
		let def: IntegrationDefinition;
		let resolved: Record<string, unknown>;
		if (request.source === 'stored') {
			const head = await this.getHead(scope, request.id);
			const current = await this.loadCurrent(scope, head);
			def = current.def;
			resolved = await this.open(scope, head.id, def, current.config);
		} else {
			def = this.registry.get(request.kind);
			if (request.id !== undefined) {
				const head = await this.getHead(scope, request.id);
				if (head.kind !== request.kind) {
					throw new ValidationError(
						'Draft integration kind does not match the stored integration.',
					);
				}
				const current = await this.loadCurrent(scope, head);
				const stored = await this.seal(scope, head.id, def, request.config, current.config);
				resolved = await this.open(scope, head.id, def, stored);
			} else {
				// New drafts use an in-memory codec so testing does not require persistence.
				const transient = transientSealer(
					(ref) => this.storeReference(ref),
					(ref, at) => this.resolveReference(ref, at),
				);
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
		}
		if (!def.testConnection) {
			throw new ValidationError(`Integration kind "${def.kind}" does not support testing.`);
		}
		const probe = this.probe;
		if (!probe) {
			throw new ValidationError('Connection testing is not enabled on this deployment.');
		}
		// Never surface the Zod issues here — the resolved config is plaintext.
		const parsed = def.configSchema.safeParse(resolved);
		if (!parsed.success) {
			throw new ValidationError(
				`Stored config no longer matches kind "${def.kind}" — edit and re-save it.`,
			);
		}
		return def.testConnection(parsed.data, probe);
	}

	/**
	 * Loads, decrypts, validates, and renders one enabled head into the given
	 * project's session. The storage scope and the render target are independent:
	 * an org-scoped instance still renders with the session's project id.
	 */
	async renderOne(
		scope: IntegrationScope,
		head: IntegrationRecord,
		renderProjectId: ProjectId,
		context: SessionRenderContext,
	): Promise<RenderedIntegration> {
		const { def, version, config } = await this.loadCurrent(scope, head);
		const resolved = await this.open(scope, head.id, def, config);
		const parsed = def.configSchema.safeParse(resolved);
		if (!parsed.success) {
			// Never surface the Zod issues here — the resolved config is plaintext.
			throw new ValidationError(
				`Integration "${head.name}" has a stored config that no longer matches ` +
					`kind "${head.kind}" — edit and re-save it.`,
			);
		}
		let output: ReturnType<typeof def.render>;
		try {
			output = def.render({
				config: parsed.data,
				instanceName: head.name,
				projectId: renderProjectId,
				principal: context.principal,
				session: { sessionId: context.sessionId },
			});
		} catch {
			throw new ValidationError(`Integration "${head.name}" could not be rendered.`);
		}
		return {
			id: head.id,
			name: head.name,
			kind: head.kind,
			version: version.version,
			requirements: def.resolveRequirements?.(parsed.data) ?? def.requirements,
			output,
		};
	}

	async listHeads(scope: IntegrationScope): Promise<IntegrationRecord[]> {
		const prefix = scope.prefix;
		const dirs: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.bucket.list({
				prefix,
				delimiter: '/',
				cursor,
				limit: MAX_INTEGRATIONS_PER_SCOPE + 2,
			});
			dirs.push(...page.delimitedPrefixes);
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);

		const instanceDirs = dirs.filter((dir) => !dir.endsWith('/_names/'));
		const heads = await mapWithConcurrency(instanceDirs, BUCKET_SCAN_CONCURRENCY, async (dir) => {
			const body = await this.bucket.get(`${dir}integration.json`);
			if (!body) return null; // deleted between list and get — skip
			const raw = await readStoredJson(body, `${dir}integration.json`);
			if (isTombstoned(raw)) return null; // a committed delete, sweep pending
			const head = parseStored(IntegrationRecordSchema, raw, `${dir}integration.json`);
			const rawId = dir.slice(prefix.length, -1);
			if (!rawId) throw new ValidationError(`Invalid integration path "${dir}".`);
			this.assertHeadIdentity(scope, rawId as IntegrationId, head);
			return head;
		});
		const liveHeads = heads.filter((h) => h !== null);
		if (liveHeads.length > MAX_INTEGRATIONS_PER_SCOPE) {
			throw new ResourceExhaustedError(
				`Integration limit exceeded ${scope.where} (${MAX_INTEGRATIONS_PER_SCOPE}).`,
			);
		}
		return liveHeads;
	}

	private async getHead(scope: IntegrationScope, id: IntegrationId): Promise<IntegrationRecord> {
		const body = await this.bucket.get(scope.integration(id).head);
		if (!body) throw new NotFoundError(`Integration ${id} not found`);
		return this.parseHead(scope, id, await readStoredJson(body, scope.integration(id).head));
	}

	/** A tombstoned head is gone as far as every reader and writer is concerned. */
	private parseHead(scope: IntegrationScope, id: IntegrationId, raw: unknown): IntegrationRecord {
		if (isTombstoned(raw)) throw new NotFoundError(`Integration ${id} not found`);
		const head = parseStored(IntegrationRecordSchema, raw, `integration ${id}`);
		this.assertHeadIdentity(scope, id, head);
		return head;
	}

	private async getVersion(
		scope: IntegrationScope,
		head: IntegrationRecord,
		version: number,
	): Promise<IntegrationVersionRecord> {
		const key = scope.integration(head.id).version(version);
		const body = await this.bucket.get(key);
		if (!body) throw new NotFoundError(`Integration ${head.id} version ${version} not found`);
		const record = await readStored(IntegrationVersionRecordSchema, body, key);
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

	/**
	 * A head must match both its id and its scope: a project head carries that
	 * project's id, an org head carries none. A record reached through the wrong
	 * tier's path fails here rather than leaking across scopes.
	 */
	private assertHeadIdentity(
		scope: IntegrationScope,
		id: IntegrationId,
		head: IntegrationRecord,
	): void {
		if (head.id !== id || head.project_id !== scope.projectId) {
			throw new ValidationError(`Integration ${id} metadata does not match its storage path.`);
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
		scope: IntegrationScope,
		head: IntegrationRecord,
		record: Omit<IntegrationVersionRecord, 'version'>,
	): Promise<number> {
		let version = head.current_version + 1;
		const integrationPaths = scope.integration(head.id);
		return withCasRetry(
			this.bucket,
			async (cas) => {
				await cas.put(integrationPaths.version(version), JSON.stringify({ ...record, version }), {
					onlyIfNotExists: true,
				});
				return version;
			},
			{
				onConflict: () => {
					version += 1;
				},
			},
		);
	}

	private async assertNameFree(scope: IntegrationScope, name: string): Promise<void> {
		const heads = await this.listHeads(scope);
		if (heads.some((h) => h.name === name)) {
			throw new ValidationError(`An integration named "${name}" already exists ${scope.where}.`);
		}
	}

	private nameClaimConfig(scope: IntegrationScope, name: string) {
		return {
			bucket: this.bucket,
			key: scope.nameClaim(name),
			serialize: (holder: string | null) =>
				JSON.stringify({ integration_id: holder, claimed_at: this.now() }),
			parseHolder: (raw: unknown): string | null => {
				const holder = (raw as { integration_id?: unknown }).integration_id;
				return typeof holder === 'string' ? holder : null;
			},
		};
	}

	// The claim is the atomic name arbiter; the earlier listing check is only a fast path.
	private async claimName(scope: IntegrationScope, name: string, id: IntegrationId): Promise<void> {
		const claim = await acquireSingletonClaim(
			{
				...this.nameClaimConfig(scope, name),
				isHolderLive: async (holder) => {
					try {
						return (await this.getHead(scope, holder as IntegrationId)).name === name;
					} catch {
						return false;
					}
				},
			},
			id,
		);
		if (!claim.acquired) {
			throw new ValidationError(`An integration named "${name}" already exists ${scope.where}.`);
		}
	}

	private async releaseName(
		scope: IntegrationScope,
		name: string,
		id: IntegrationId,
	): Promise<void> {
		await releaseSingletonClaim(this.nameClaimConfig(scope, name), id);
	}

	private async loadCurrent(
		scope: IntegrationScope,
		head: IntegrationRecord,
	): Promise<{
		def: IntegrationDefinition;
		version: IntegrationVersionRecord;
		config: Record<string, unknown>;
	}> {
		const def = this.registry.get(head.kind);
		const version = await this.getVersion(scope, head, head.current_version);
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
		scope: IntegrationScope,
		id: IntegrationId,
		def: IntegrationDefinition,
		authoring: Record<string, unknown>,
		previous?: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const codec = this.codec;
		const contextFor = this.secretContext(scope, id);
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
				reference: (ref) => this.storeReference(ref),
			},
		});
	}

	private async open(
		scope: IntegrationScope,
		id: IntegrationId,
		def: IntegrationDefinition,
		stored: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const codec = this.codec;
		const contextFor = this.secretContext(scope, id);
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
				resolve: (ref, at) => this.resolveReference(ref, at),
			},
		});
	}

	private storeReference(ref: SecretRef): Promise<StoredSecretValue> {
		if (!this.resolvers.has(ref.backend)) {
			throw new ValidationError(
				`Unknown secret backend "${ref.backend}" — no resolver is configured for it.`,
			);
		}
		return Promise.resolve({
			$secret: { kind: 'reference', backend: ref.backend, locator: ref.locator },
		});
	}

	private async resolveReference(ref: SecretRef, at: string): Promise<string> {
		const resolver = this.resolvers.get(ref.backend);
		if (!resolver) {
			throw new ValidationError(
				`Cannot resolve secret field "${at}": backend "${ref.backend}" is not configured.`,
			);
		}
		try {
			return await resolver.resolve(ref);
		} catch (err) {
			if (err instanceof SecretResolutionError && err.reason === 'forbidden') {
				// Persistent permission gap, not an outage: 422 so nobody retries it,
				// plus an operator trail since the fix is backend-side (e.g. IAM).
				logOperationalError(
					'secret_resolution_forbidden',
					{ operation: 'integration.secret.resolve', backend: ref.backend, field: at },
					err,
				);
				throw new ValidationError(
					`Secret backend "${ref.backend}" denied access to the secret for field "${at}". Check the deployment's secret-manager permissions.`,
				);
			}
			if (err instanceof SecretResolutionError && err.reason !== 'unavailable') {
				throw new ValidationError(
					`Cannot resolve secret field "${at}" with backend "${ref.backend}".`,
				);
			}
			logOperationalError(
				'secret_resolution_failed',
				{ operation: 'integration.secret.resolve', backend: ref.backend, field: at },
				err,
			);
			throw new UnavailableError(`Secret backend "${ref.backend}" is temporarily unavailable.`);
		}
	}

	/**
	 * Encryption context: head path + wildcard field path. Stable across version
	 * bumps and array reorders (never a concrete index or version number), unique
	 * per integration + field class — a leaked envelope cannot be replayed
	 * elsewhere (including across scopes: org and project head paths differ).
	 */
	private secretContext(scope: IntegrationScope, id: IntegrationId): (at: string) => string {
		const base = scope.integration(id).head;
		return (at) => `${base}#${at}`;
	}

	/** `config` must be the MIGRATED stored config (see `loadCurrent`), so the
	 *  current kind's secret paths line up and redaction cannot miss a moved field. */
	private toDetail(
		scope: IntegrationScope,
		head: IntegrationRecord,
		version: IntegrationVersionRecord,
		config: Record<string, unknown>,
	): IntegrationDetail {
		return {
			...toEntry(scope, head),
			config: redactConfig(config, this.registry.secretPathsOf(head.kind)),
			...(version.change_note ? { change_note: version.change_note } : {}),
		};
	}
}

/**
 * Project-tier facade. Reads (`list`, `resolveForSession`) always merge the org
 * tier in: org instances are inherited by every project, and a same-name
 * project instance — enabled or not — shadows the org one, making it both the
 * per-project override and the opt-out.
 */
export class ProjectIntegrationsStore implements ProjectIntegrationsService {
	private readonly store: ScopedIntegrationsStore;

	constructor(options: IntegrationsStoreOptions) {
		this.store = new ScopedIntegrationsStore(options);
	}

	listKinds(): KindDescriptor[] {
		return this.store.listKinds();
	}

	secretSources(): IntegrationSecretSources {
		return this.store.secretSources();
	}

	async list(projectId: ProjectId): Promise<IntegrationEntry[]> {
		const scope = projectScope(projectId);
		const [project, org] = await Promise.all([
			this.store.listHeads(scope),
			this.store.listHeads(ORG_SCOPE),
		]);
		const projectNames = new Set(project.map((h) => h.name));
		return [
			...project.map((h) => toEntry(scope, h)),
			...org.map((h) => ({
				...toEntry(ORG_SCOPE, h),
				...(projectNames.has(h.name) ? { shadowed: true } : {}),
			})),
		].sort(
			(a, b) =>
				a.name.localeCompare(b.name) || (a.scope === b.scope ? 0 : a.scope === 'org' ? 1 : -1),
		);
	}

	get(projectId: ProjectId, id: IntegrationId): Promise<IntegrationDetail> {
		return this.store.get(projectScope(projectId), id);
	}

	create(
		projectId: ProjectId,
		input: CreateIntegrationInput,
		actor: UserId,
	): Promise<IntegrationDetail> {
		return this.store.create(projectScope(projectId), input, actor);
	}

	update(
		projectId: ProjectId,
		id: IntegrationId,
		input: UpdateIntegrationInput,
		actor: UserId,
		expectedVersion?: string,
	): Promise<IntegrationDetail> {
		return this.store.update(projectScope(projectId), id, input, actor, expectedVersion);
	}

	delete(projectId: ProjectId, id: IntegrationId, expectedVersion?: string): Promise<boolean> {
		return this.store.delete(projectScope(projectId), id, expectedVersion);
	}

	listVersions(
		projectId: ProjectId,
		id: IntegrationId,
		page?: IntegrationVersionPageRequest,
	): Promise<IntegrationVersionPage> {
		return this.store.listVersions(projectScope(projectId), id, page);
	}

	test(projectId: ProjectId, request: TestIntegrationRequest): Promise<TestResult> {
		return this.store.test(projectScope(projectId), request);
	}

	copy(
		sourceProjectId: ProjectId,
		id: IntegrationId,
		targetProjectId: ProjectId,
		options: CopyIntegrationOptions,
		actor: UserId,
	): Promise<IntegrationDetail> {
		return this.store.copy(
			projectScope(sourceProjectId),
			id,
			projectScope(targetProjectId),
			options,
			actor,
		);
	}

	async resolveForSession(
		projectId: ProjectId,
		context: SessionRenderContext,
	): Promise<SessionRender | undefined> {
		const scope = projectScope(projectId);
		const [project, org] = await Promise.all([
			this.store.listHeads(scope),
			this.store.listHeads(ORG_SCOPE),
		]);
		// Shadowing keys off existence, not `enabled`: a disabled same-name project
		// instance still suppresses the org one (that is the opt-out), and it keeps
		// the active set free of cross-scope name collisions.
		const projectNames = new Set(project.map((h) => h.name));
		const active = [
			...org
				.filter((h) => h.enabled && !projectNames.has(h.name))
				.map((head) => ({ scope: ORG_SCOPE, head })),
			...project.filter((h) => h.enabled).map((head) => ({ scope, head })),
		].sort((a, b) => a.head.name.localeCompare(b.head.name));
		if (active.length === 0) return undefined;

		const rendered = await mapWithConcurrency(active, BUCKET_SCAN_CONCURRENCY, (item) =>
			this.store.renderOne(item.scope, item.head, projectId, context),
		);
		return bundleIntegrations(rendered, context.sessionId);
	}
}

/**
 * Org-tier facade: deployment-wide instances under `_system/integrations/`.
 * CRUD only — session rendering goes through `ProjectIntegrationsStore`, which
 * merges this tier into every project.
 */
export class OrgIntegrationsStore implements OrgIntegrationsService {
	private readonly store: ScopedIntegrationsStore;

	constructor(options: IntegrationsStoreOptions) {
		this.store = new ScopedIntegrationsStore(options);
	}

	listKinds(): KindDescriptor[] {
		return this.store.listKinds();
	}

	secretSources(): IntegrationSecretSources {
		return this.store.secretSources();
	}

	list(): Promise<IntegrationEntry[]> {
		return this.store.list(ORG_SCOPE);
	}

	get(id: IntegrationId): Promise<IntegrationDetail> {
		return this.store.get(ORG_SCOPE, id);
	}

	create(input: CreateIntegrationInput, actor: UserId): Promise<IntegrationDetail> {
		return this.store.create(ORG_SCOPE, input, actor);
	}

	update(
		id: IntegrationId,
		input: UpdateIntegrationInput,
		actor: UserId,
		expectedVersion?: string,
	): Promise<IntegrationDetail> {
		return this.store.update(ORG_SCOPE, id, input, actor, expectedVersion);
	}

	delete(id: IntegrationId, expectedVersion?: string): Promise<boolean> {
		return this.store.delete(ORG_SCOPE, id, expectedVersion);
	}

	listVersions(
		id: IntegrationId,
		page?: IntegrationVersionPageRequest,
	): Promise<IntegrationVersionPage> {
		return this.store.listVersions(ORG_SCOPE, id, page);
	}

	test(request: TestIntegrationRequest): Promise<TestResult> {
		return this.store.test(ORG_SCOPE, request);
	}
}

function toEntry(scope: IntegrationScope, head: IntegrationRecord): IntegrationEntry {
	return {
		id: head.id,
		kind: head.kind,
		name: head.name,
		enabled: head.enabled,
		current_version: head.current_version,
		created_by: head.created_by,
		created_at: head.created_at,
		updated_at: head.updated_at,
		scope: scope.projectId === undefined ? 'org' : 'project',
	};
}

function nextTimestamp(current: string, candidate: string): string {
	const currentMs = Date.parse(current);
	const candidateMs = Date.parse(candidate);
	return candidateMs > currentMs ? candidate : new Date(currentMs + 1).toISOString();
}

/** In-memory seal/open pair used to validate unsaved configs. */
function transientSealer(
	reference: (ref: SecretRef) => Promise<StoredSecretValue>,
	resolve: (ref: SecretRef, at: string) => Promise<string>,
) {
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
		reference: (ref: SecretRef) => reference(ref),
		resolve: (ref: SecretRef, at: string) => resolve(ref, at),
	};
}
