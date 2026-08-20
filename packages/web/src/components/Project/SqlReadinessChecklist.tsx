import { Check, CircleAlert } from 'lucide-react';
import { schemaFieldId } from '@/components/form/schema-form';

export interface SqlReadinessCheck {
	label: string;
	ready: boolean;
	field: string;
}

const asRecord = (value: unknown): Record<string, unknown> =>
	typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

function catalogUrlReady(value: unknown): boolean {
	if (typeof value !== 'string') return false;
	try {
		const url = new URL(value);
		return url.search === '' && !/%2f|%5c/i.test(url.pathname);
	} catch {
		return false;
	}
}

function storageEndpointReady(value: unknown): boolean {
	if (typeof value !== 'string' || value === '') return false;
	try {
		const url = new URL(value);
		return url.pathname === '/' && url.search === '' && url.hash === '';
	} catch {
		return false;
	}
}

const advancedStorageKeys = [
	'role_arn',
	'role_session_name',
	'signer',
	'signer_uri',
	'signer_endpoint',
	'resolve_region',
	'proxy_uri',
	'connect_timeout',
	'request_timeout',
] as const;

export function icebergRestSqlReadiness(config: Record<string, unknown>): SqlReadinessCheck[] {
	const auth = asRecord(config.auth);
	const tls = asRecord(config.tls);
	const headers = asRecord(config.headers);
	const extraProperties = asRecord(config.extra_properties);
	const storage = asRecord(config.storage);
	const credentials = asRecord(storage.credentials);
	const runtime = asRecord(config.runtime);
	const rest = asRecord(config.rest);
	const storageIsS3 = storage.scheme === 's3';
	const advancedStorageBlocker = advancedStorageKeys.find((key) => Boolean(storage[key]));
	const usesSupportedCredentials =
		storageIsS3 && (storage.anonymous === true || credentials.method === 'static');
	const usesDefaultRestOptions =
		(rest.snapshot_loading_mode ?? 'all') === 'all' &&
		(rest.metrics_reporting_enabled ?? true) === true &&
		rest.page_size === undefined &&
		(rest.view_endpoints_supported ?? false) === false &&
		(rest.scan_planning_mode ?? 'client') === 'client' &&
		(rest.namespace_separator ?? '%1F') === '%1F' &&
		(rest.table_cache_expire_after_write_ms ?? 300_000) === 300_000 &&
		(rest.table_cache_max_entries ?? 100) === 100;

	return [
		{
			label: 'Use no catalog authentication or a bearer token',
			ready: auth.method === 'none' || auth.method === 'bearer_token',
			field: 'auth',
		},
		{
			label: 'Use system TLS without custom certificates',
			ready: !tls.ca_bundle && !tls.client_certificate,
			field: 'tls',
		},
		{
			label: 'Remove custom headers and extra properties',
			ready: Object.keys(headers).length === 0 && Object.keys(extraProperties).length === 0,
			field: Object.keys(headers).length > 0 ? 'headers' : 'extra_properties',
		},
		{
			label: 'Use a catalog URL without query parameters or encoded path separators',
			ready: catalogUrlReady(config.uri),
			field: 'uri',
		},
		{
			label: 'Set access delegation to none',
			ready: config.access_delegation === 'none',
			field: 'access_delegation',
		},
		{
			label: 'Switch Storage to the s3 scheme',
			ready: storageIsS3,
			field: 'storage',
		},
		{
			label: 'Set an origin-only S3 endpoint',
			ready: storageIsS3 && storageEndpointReady(storage.endpoint),
			field: storageIsS3 ? 'storage.endpoint' : 'storage',
		},
		{
			label: 'Use path-style S3 addressing and no advanced client options',
			ready:
				storageIsS3 &&
				storage.force_virtual_addressing !== true &&
				advancedStorageKeys.every((key) => !storage[key]),
			field: storageIsS3
				? storage.force_virtual_addressing === true
					? 'storage.force_virtual_addressing'
					: advancedStorageBlocker
						? `storage.${advancedStorageBlocker}`
						: 'storage.force_virtual_addressing'
				: 'storage',
		},
		{
			label: 'Use static S3 credentials or anonymous access',
			ready: usesSupportedCredentials,
			field: storageIsS3 ? 'storage.credentials' : 'storage',
		},
		{
			label: 'Add at least one guarded S3 read location',
			ready:
				storageIsS3 &&
				Array.isArray(storage.broker_read_locations) &&
				storage.broker_read_locations.length > 0,
			field: storageIsS3 ? 'storage.broker_read_locations' : 'storage',
		},
		{
			label: 'Keep PyIceberg runtime options at their defaults',
			ready: Object.keys(runtime).length === 0,
			field: 'runtime',
		},
		{
			label: 'Keep REST client options at their defaults',
			ready: usesDefaultRestOptions,
			field: 'rest',
		},
	];
}

function revealField(path: string) {
	const target = document.getElementById(schemaFieldId(path));
	if (!target) return;
	let disclosure = target.closest('details');
	while (disclosure) {
		disclosure.open = true;
		disclosure = disclosure.parentElement?.closest('details') ?? null;
	}
	requestAnimationFrame(() => {
		target.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
		target.querySelector<HTMLElement>('input, textarea, button, select, summary')?.focus();
	});
}

export function SqlReadinessChecklist({ config }: { config: Record<string, unknown> }) {
	const checks = icebergRestSqlReadiness(config);
	const readyCount = checks.filter((check) => check.ready).length;
	const ready = readyCount === checks.length;

	return (
		<section className="rounded-lg border bg-muted/20 p-3" aria-labelledby="sql-readiness-title">
			<div className="flex items-start gap-2">
				{ready ? (
					<Check className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
				) : (
					<CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
				)}
				<div>
					<h4 id="sql-readiness-title" className="text-xs font-semibold">
						Run SQL readiness
					</h4>
					<p className="mt-0.5 text-xs text-muted-foreground">
						{ready
							? 'This configuration is SQL-ready. Deployment-level Run SQL settings still apply.'
							: `${readyCount} of ${checks.length} configuration checks pass. Select a failing check to edit its field.`}
					</p>
				</div>
			</div>
			<ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
				{checks.map((check) => (
					<li key={check.label}>
						<a
							href={`#${schemaFieldId(check.field)}`}
							onClick={(event) => {
								event.preventDefault();
								revealField(check.field);
							}}
							className="flex items-start gap-1.5 rounded px-1.5 py-1 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							{check.ready ? (
								<Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600" aria-hidden />
							) : (
								<CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" aria-hidden />
							)}
							<span className={check.ready ? 'text-muted-foreground' : 'text-foreground'}>
								{check.label}
							</span>
						</a>
					</li>
				))}
			</ul>
		</section>
	);
}
