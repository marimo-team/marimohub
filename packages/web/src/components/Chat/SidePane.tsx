import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { IconButton } from '@/components/ui';
import { cn } from '@/lib/utils';

/** The resizable column beside the transcript; stacks under it on small screens. */
export function SidePane({
	label,
	width,
	title,
	actions,
	closeLabel,
	onClose,
	children,
	className,
}: {
	label: string;
	width: number;
	title: ReactNode;
	actions?: ReactNode;
	closeLabel: string;
	onClose: () => void;
	children: ReactNode;
	className?: string;
}) {
	return (
		<aside
			aria-label={label}
			className={cn(
				'flex min-h-[50vh] min-w-0 shrink-0 flex-col border-t lg:min-h-0 lg:basis-[var(--pane-width)] lg:border-t-0',
				className,
			)}
			style={{ '--pane-width': `${width}%` } as React.CSSProperties}
		>
			<header className="flex shrink-0 items-start justify-between gap-2 border-b px-3 py-2">
				<div className="min-w-0 flex-1">{title}</div>
				<div className="flex shrink-0 items-center gap-1">
					{actions}
					<IconButton label={closeLabel} onPress={onClose}>
						<X className="size-4" aria-hidden />
					</IconButton>
				</div>
			</header>
			{children}
		</aside>
	);
}
