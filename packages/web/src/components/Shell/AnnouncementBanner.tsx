import { useState } from 'react';
import { X } from 'lucide-react';
import { useBranding } from '@/context/BrandingContext';
import type { ThemeConfig } from '@marimo-hub/core/theme';
import { shellLinkTarget } from './useShellLinks';

export function AnnouncementBanner() {
	const { announcement } = useBranding();
	return announcement ? <Banner key={announcement.id} announcement={announcement} /> : null;
}

function Banner({ announcement }: { announcement: NonNullable<ThemeConfig['announcement']> }) {
	const storageKey = `marimohub-announcement:${announcement.id}`;
	const [dismissed, setDismissed] = useState(() => {
		try {
			return localStorage.getItem(storageKey) === 'dismissed';
		} catch {
			return false;
		}
	});
	if (dismissed && announcement.dismissible) return null;
	return (
		<aside
			aria-label="Announcement"
			className={`flex shrink-0 items-center gap-3 border-b px-4 py-2 text-sm ${announcement.level === 'warning' ? 'border-amber-500/30 bg-amber-500/15' : 'bg-accent text-accent-foreground'}`}
		>
			<span className="min-w-0 flex-1 break-words">
				{announcement.href ? (
					<a
						href={announcement.href}
						target={shellLinkTarget({ href: announcement.href })}
						rel="noopener noreferrer"
						className="underline underline-offset-2"
					>
						{announcement.text}
					</a>
				) : (
					announcement.text
				)}
			</span>
			{announcement.dismissible && (
				<button
					type="button"
					aria-label="Dismiss announcement"
					className="rounded p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					onClick={() => {
						setDismissed(true);
						try {
							localStorage.setItem(storageKey, 'dismissed');
						} catch {
							/* Dismissal still works when browser storage is disabled. */
						}
					}}
				>
					<X className="size-4" />
				</button>
			)}
		</aside>
	);
}
