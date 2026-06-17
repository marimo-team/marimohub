import type { ReactNode } from 'react';
import { Info, ExternalLink } from 'lucide-react';
import { useVersionQuery } from '@/api/hooks';
import { Popover } from '@/components/ui';
import { formatRelative } from '@/lib/time';

/** Source repository — the UI derives commit + issue links from it. */
const SOURCE_URL = 'https://github.com/marimo-team/marimohub';

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
	return (
		<>
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="min-w-0 break-all text-foreground">{value}</dd>
		</>
	);
}

/** A timestamp shown as a relative phrase, with the exact value on hover. */
function Timestamp({ iso }: { iso: string }) {
	return (
		<time dateTime={iso} title={iso} className="tabular-nums">
			{formatRelative(iso) || iso}
		</time>
	);
}

/**
 * Slim bottom bar with a single info affordance: clicking it opens a popover with
 * the deployment's version, image, start time, replica, runtime, and active
 * backends (from `GET /api/v1/version`). The bar renders even while the query is in
 * flight or has failed — the popover just shows what's known — so it never blocks
 * or shifts the layout.
 */
export function Footer() {
	const { data: v } = useVersionQuery();

	const isRealVersion = v ? v.version !== 'dev' : false;
	const versionValue = isRealVersion ? (
		<a
			href={`${SOURCE_URL}/commit/${v!.version}`}
			target="_blank"
			rel="noreferrer"
			className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
		>
			<span className="tabular-nums">{v!.version}</span>
			<ExternalLink className="size-3 shrink-0 text-muted-foreground" />
		</a>
	) : (
		<span className="tabular-nums">{v?.version ?? 'unknown'}</span>
	);

	return (
		<footer className="flex shrink-0 items-center justify-between border-t bg-background px-4 py-2 max-md:px-3">
			<span className="font-mono text-[11px] tracking-[0.12em] text-muted-foreground/60">
				MARIMOHUB
			</span>
			<Popover
				label="Version info"
				placement="top end"
				trigger={<Info className="size-3.5" />}
				triggerClassName="rounded-full text-muted-foreground transition-colors hover:text-foreground"
			>
				<div className="flex min-w-[16rem] flex-col gap-2 text-xs">
					<div className="font-medium text-foreground">marimohub</div>
					<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
						<InfoRow label="Version" value={versionValue} />
						{v?.image && <InfoRow label="Image" value={v.image} />}
						{v?.sandbox_image && <InfoRow label="Sandbox image" value={v.sandbox_image} />}
						{v?.started_at && <InfoRow label="Started" value={<Timestamp iso={v.started_at} />} />}
						{v?.replica && <InfoRow label="Replica" value={v.replica} />}
						{v?.node && (
							<InfoRow label="Node" value={<span className="tabular-nums">{v.node}</span>} />
						)}
						{v?.backends && (
							<InfoRow
								label="Backends"
								value={
									<span className="tabular-nums">
										{v.backends.storage} · {v.backends.compute} · {v.backends.auth}
									</span>
								}
							/>
						)}
					</dl>
					<div className="flex gap-3 border-t pt-2 text-muted-foreground">
						<a
							href={SOURCE_URL}
							target="_blank"
							rel="noreferrer"
							className="underline-offset-4 hover:text-foreground hover:underline"
						>
							Source
						</a>
						<a
							href={`${SOURCE_URL}/issues`}
							target="_blank"
							rel="noreferrer"
							className="underline-offset-4 hover:text-foreground hover:underline"
						>
							Report an issue
						</a>
					</div>
				</div>
			</Popover>
		</footer>
	);
}
