import { useBranding } from '@/context/BrandingContext';
import type { ReactNode } from 'react';
import { Bug, Code2, ExternalLink } from 'lucide-react';
import { useVersionQuery } from '@/api/hooks';
import { SOURCE_URL, versionHref } from '@/lib/deployment';

const ROW_CLASS =
	'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5 [&_svg]:shrink-0';

function LinkRow({ href, icon, children }: { href: string; icon: ReactNode; children: ReactNode }) {
	return (
		<a href={href} target="_blank" rel="noreferrer" className={ROW_CLASS}>
			{icon}
			<span className="flex-1">{children}</span>
			<ExternalLink className="text-muted-foreground/50" />
		</a>
	);
}

export function AboutHub() {
	const { name } = useBranding();
	const { data: v } = useVersionQuery();
	const version = v?.version ?? 'unknown';
	const href = versionHref(version);
	return (
		<div className="flex w-full flex-col">
			<div className="flex items-baseline justify-between gap-3 px-2 pb-2 pt-0.5">
				<span className="text-sm font-semibold">{name}</span>
				{href ? (
					<a
						href={href}
						target="_blank"
						rel="noreferrer"
						className="inline-flex items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
					>
						{version}
						<ExternalLink className="size-3 shrink-0" />
					</a>
				) : (
					<span className="font-mono text-xs tabular-nums text-muted-foreground">{version}</span>
				)}
			</div>
			{name !== 'marimohub' && (
				<p className="px-2 pb-2 text-xs text-muted-foreground">Powered by marimohub</p>
			)}
			<div className="flex flex-col gap-0.5 border-t pt-1.5">
				<LinkRow href={SOURCE_URL} icon={<Code2 />}>
					Source
				</LinkRow>
				<LinkRow href={`${SOURCE_URL}/issues`} icon={<Bug />}>
					Report an issue
				</LinkRow>
			</div>
		</div>
	);
}
