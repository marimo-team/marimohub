// Catalog recovery command implementation; the bundled entrypoint is catalog-recovery.ts.
import { parseArgs } from 'node:util';
import { CatalogService, EventService, SnapshotId, UserId } from '@marimo-hub/core';
import type { Bucket, CatalogRecoveryReport, CatalogRecoverySource } from '@marimo-hub/core';

export const CATALOG_RECOVERY_HELP = `Usage: catalog-recovery --rebuild | --snapshot <snapshot-id>

Dry-run is the default. Review the JSON report before applying its token.
A dry-run exits 2 when the report has blocking errors.

  --rebuild                Discover projects, notebooks, and jobs from records
  --snapshot <id>          Use a selected snapshot's membership with current metadata
  --apply <token>          Apply the reviewed report if storage has not changed
  --writers-stopped        Confirm all writers are stopped (required for apply)
  --accept-warnings        Accept the report's warnings (errors always block apply)
  --actor <id>             Operator user ID, written to the snapshot and the audit event log
                           (required for apply)
  --help                   Show this help

Use the deployment's MARIMOHUB_STORAGE_* environment variables.
Keep API replicas, background workers, scheduled triggers, and sandbox writers
stopped through inspection and apply. Only the catalog and snapshots are written.`;

export async function runCatalogRecovery(
	args: string[],
	makeBucket: () => Bucket,
): Promise<unknown> {
	const { values } = parseArgs({
		args,
		options: {
			rebuild: { type: 'boolean' },
			snapshot: { type: 'string' },
			apply: { type: 'string' },
			'writers-stopped': { type: 'boolean' },
			'accept-warnings': { type: 'boolean' },
			actor: { type: 'string' },
			help: { type: 'boolean' },
		},
	});
	if (values.help) return CATALOG_RECOVERY_HELP;
	if (Boolean(values.rebuild) === Boolean(values.snapshot)) {
		throw new Error('Select exactly one of --rebuild or --snapshot <id>. Use --help for usage.');
	}
	if (
		values.apply !== undefined &&
		(!values.apply || !values['writers-stopped'] || !values.actor)
	) {
		throw new Error('Apply requires a report token, --writers-stopped, and --actor <id>.');
	}
	const source: CatalogRecoverySource = values.snapshot
		? { mode: 'snapshot', snapshotId: SnapshotId.parse(values.snapshot) }
		: { mode: 'rebuild' };
	const bucket = makeBucket();
	const catalog = new CatalogService(bucket, undefined, new EventService(bucket));
	if (values.apply === undefined) return catalog.planRecovery(source);
	const snapshot = await catalog.recover(source, UserId.parse(values.actor!), {
		token: values.apply,
		writersStopped: true,
		acceptWarnings: values['accept-warnings'],
	});
	return { snapshotId: snapshot.snapshot_id, projects: snapshot.projects.length };
}

export const CATALOG_RECOVERY_BLOCKED_EXIT_CODE = 2;

/** Explains why a dry-run report cannot be applied, or returns undefined when it can. */
export function blockedRecoveryMessage(result: unknown): string | undefined {
	const issues = (result as Partial<CatalogRecoveryReport> | null)?.issues;
	const errors = Array.isArray(issues) ? issues.filter((issue) => issue.severity === 'error') : [];
	if (errors.length === 0) return undefined;
	return [
		`Recovery is blocked by ${errors.length} error issue(s); fix them and inspect again:`,
		...errors.map((issue) => `  ${issue.key}: ${issue.message}`),
	].join('\n');
}

export interface CatalogRecoveryIo {
	log(line: string): void;
	error(line: string): void;
}

/** Runs the command end to end and returns the process exit code. */
export async function catalogRecoveryMain(
	args: string[],
	makeBucket: () => Bucket,
	io: CatalogRecoveryIo,
): Promise<number> {
	try {
		const result = await runCatalogRecovery(args, makeBucket);
		io.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
		const blocked = blockedRecoveryMessage(result);
		if (!blocked) return 0;
		io.error(blocked);
		return CATALOG_RECOVERY_BLOCKED_EXIT_CODE;
	} catch (error) {
		io.error(error instanceof Error ? error.message : 'Catalog recovery failed');
		return 1;
	}
}
