import type { IntegrationEntry, IntegrationKind } from '@/types';
import { supportsObjectBrowse, supportsTableBrowse } from './integrationBrowse';

export interface IntegrationNotebookInfo {
	description: string;
	snippet: string;
}

const NOTEBOOK_INFO_BUILDERS: Record<string, (entry: IntegrationEntry) => IntegrationNotebookInfo> =
	{
		pyspark(entry) {
			return {
				description:
					'PySpark connects from the notebook process over Spark Connect. The hub cannot inspect its catalogs without opening a Spark session, so tables are available through PySpark rather than the server-side browser.',
				snippet: [
					'import json',
					'import os',
					'from pathlib import Path',
					'from pyspark.sql import SparkSession',
					'',
					`descriptor_path = Path(os.environ["MARIMOHUB_INTEGRATIONS_DIR"]).joinpath("pyspark", ${JSON.stringify(`${entry.name}.json`)})`,
					'descriptor = json.loads(descriptor_path.read_text())',
					'builder = SparkSession.builder.remote(os.environ[descriptor["remote_env"]])',
					'if app_name := descriptor.get("app_name"):',
					'    builder = builder.appName(app_name)',
					'for key, value in descriptor["spark_config"].items():',
					'    builder = builder.config(key, value)',
					'spark = builder.getOrCreate()',
					'spark',
				].join('\n'),
			};
		},
	};

export function integrationNotebookInfo(
	entry: IntegrationEntry,
	kind: IntegrationKind | undefined,
): IntegrationNotebookInfo | undefined {
	if (kind === undefined) return undefined;
	return NOTEBOOK_INFO_BUILDERS[kind.kind]?.(entry);
}

export function supportsIntegrationDataPage(kind: IntegrationKind | undefined): boolean {
	return (
		supportsTableBrowse(kind) ||
		supportsObjectBrowse(kind) ||
		(kind !== undefined && NOTEBOOK_INFO_BUILDERS[kind.kind] !== undefined)
	);
}
