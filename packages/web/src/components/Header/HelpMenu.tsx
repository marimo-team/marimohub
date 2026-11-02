import { useProblemReport } from '@/components/Support/ReportProblemDialog';
import type { SupportContext } from '@/components/Support/diagnostics';
import { DialogModal } from '@/components/ui/Dialog';
import { useDisclosure } from '@/hooks/useDisclosure';
import { CircleHelp } from 'lucide-react';
import { MenuTrigger, Button, Popover, Menu, MenuItem, Separator } from 'react-aria-components';
import type { ThemeLinkRole } from '@marimo-hub/core/theme';
import { useBranding } from '@/context/BrandingContext';
import { DOCS_BASE } from '@/lib/links';
import { shellLinkTarget, useShellLinks } from '@/components/Shell/useShellLinks';
import { AboutHub } from './AboutHub';

const ITEM_CLASS = 'block cursor-pointer rounded px-3 py-2 text-sm outline-none focus:bg-muted';

export function HelpMenu({
	linkRole,
	session,
}: {
	linkRole?: ThemeLinkRole;
	session?: SupportContext['session'];
}) {
	const report = useProblemReport({ session });
	const { name, docs_url, support_url } = useBranding();
	const customLinks = useShellLinks('help', linkRole);
	const links = [
		{ id: 'documentation', label: 'Documentation', href: docs_url ?? DOCS_BASE },
		...(support_url ? [{ id: 'support', label: 'Get help', href: support_url }] : []),
		...customLinks,
	];
	const about = useDisclosure();
	return (
		<>
			<MenuTrigger>
				<Button
					aria-label="Help"
					className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<CircleHelp className="size-4" />
				</Button>
				<Popover
					placement="bottom end"
					className="scrollable-overlay z-50 min-w-48 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg"
				>
					<Menu aria-label="Help" className="outline-none">
						{links.map((link) => (
							<MenuItem
								key={link.id}
								id={link.id}
								href={link.href}
								target={shellLinkTarget(link)}
								rel="noopener noreferrer"
								className={ITEM_CLASS}
							>
								{link.label}
							</MenuItem>
						))}
						<MenuItem id="report" onAction={() => void report.open()} className={ITEM_CLASS}>
							Report a problem
						</MenuItem>
						<Separator className="my-1 h-px bg-border" />
						<MenuItem id="about" onAction={about.open} className={ITEM_CLASS}>
							About {name}
						</MenuItem>
					</Menu>
				</Popover>
			</MenuTrigger>
			{report.dialog}
			<DialogModal isOpen={about.isOpen} onClose={about.close} title={`About ${name}`} width="sm">
				<AboutHub />
			</DialogModal>
		</>
	);
}
