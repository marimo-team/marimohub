import { parseArgs } from 'node:util';
import { CatalogService, SnapshotId, UserId } from '@marimo-hub/core';
import type { Bucket, CatalogRecoverySource } from '@marimo-hub/core';

export const CATALOG_RECOVERY_HELP = `Usage: catalog-recovery --rebuild | --snapshot <snapshot-id>

Dry-run is the default. The JSON report includes surviving snapshot candidates,
recovered entries, issues, and a token binding approval to the inspected storage.

  --rebuild                Discover projects, notebooks, and jobs from records
  --snapshot <id>          Use a selected snapshot's membership with current metadata
  --apply <token>          Apply the reviewed report if storage has not changed
  --writers-stopped        Confirm all writers are stopped (required for apply)
  --accept-warnings        Accept the report's warnings (errors always block apply)
  --actor <id>             Operator identity for the recovery audit (required for apply)
  --help                   Show this help

Use the deployment's MARIMOHUB_STORAGE_* environment variables.
Stop API replicas, background workers, scheduled triggers, and sandbox writers
before inspection and apply. Recovery changes only the catalog and its snapshots.`;

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
	const catalog = new CatalogService(makeBucket());
	if (values.apply === undefined) return catalog.planRecovery(source);
	const snapshot = await catalog.recover(source, UserId.parse(values.actor!), {
		token: values.apply,
		writersStopped: true,
		acceptWarnings: values['accept-warnings'],
	});
	return { snapshotId: snapshot.snapshot_id, projects: snapshot.projects.length };
}
