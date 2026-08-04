import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bug, Code2, ExternalLink, Info, Settings2 } from 'lucide-react';
import { useVersionQuery } from '@/api/hooks';
import { Popover } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
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

/**
 * Slim bottom bar with a single info affordance: a compact popover with the
 * deployment version (linked to its release/commit when the shape allows) and
 * source/issue links. Super admins get a shortcut to the admin settings page,
 * where the full deployment/config detail lives. The bar renders even while
 * the version query is in flight or has failed — the popover just shows what's
 * known — so it never blocks or shifts the layout.
 */
export function Footer() {
	const { data: v } = useVersionQuery();
	const { user } = useAuth();
	const navigate = useNavigate();
	const isSuperAdmin = user?.is_super_admin ?? false;

	const version = v?.version ?? 'unknown';
	const href = versionHref(version);

	return (
		<footer className="flex shrink-0 items-center justify-between border-t bg-background px-4 py-2 max-md:px-3">
			<span className="font-mono text-[11px] tracking-[0.12em] text-muted-foreground/60">
				MARIMOHUB
			</span>
			<Popover
				label="About marimohub"
				placement="top end"
				trigger={<Info className="size-3.5" />}
				triggerClassName="rounded-full text-muted-foreground transition-colors hover:text-foreground"
			>
				{({ close }) => (
					<div className="flex w-56 flex-col">
						<div className="flex items-baseline justify-between gap-3 px-2 pb-2 pt-0.5">
							<span className="text-sm font-semibold">marimohub</span>
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
								<span className="font-mono text-xs tabular-nums text-muted-foreground">
									{version}
								</span>
							)}
						</div>
						<div className="flex flex-col gap-0.5 border-t pt-1.5">
							<LinkRow href={SOURCE_URL} icon={<Code2 />}>
								Source
							</LinkRow>
							<LinkRow href={`${SOURCE_URL}/issues`} icon={<Bug />}>
								Report an issue
							</LinkRow>
							{isSuperAdmin && (
								<button
									type="button"
									className={ROW_CLASS}
									onClick={() => {
										close();
										void navigate('/admin/settings');
									}}
								>
									<Settings2 />
									<span className="flex-1">Deployment settings</span>
								</button>
							)}
						</div>
					</div>
				)}
			</Popover>
		</footer>
	);
}
