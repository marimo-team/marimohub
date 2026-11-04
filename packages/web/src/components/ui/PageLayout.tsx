import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type PageWidth = 'normal' | 'wide' | 'full';
export type PageScroll = 'page' | 'panels';
export type MobilePageActions = 'stack' | 'inline';

const PAGE_WIDTHS: Record<PageWidth, string> = {
	normal: 'max-w-3xl',
	wide: 'max-w-7xl',
	full: 'max-w-none',
};

export function PageContainer({
	children,
	width = 'normal',
	scroll = 'page',
	className,
	contentClassName,
}: {
	children: ReactNode;
	width?: PageWidth;
	scroll?: PageScroll;
	className?: string;
	contentClassName?: string;
}) {
	return (
		<div
			className={cn(
				'flex min-h-0 min-w-0 flex-1 items-start justify-start px-6 pb-6 max-md:px-3 max-md:pb-3',
				scroll === 'page'
					? 'overflow-y-auto'
					: 'overflow-hidden pt-6 max-md:overflow-y-auto max-md:pt-3',
				className,
			)}
		>
			<div
				className={cn(
					'w-full min-w-0',
					PAGE_WIDTHS[width],
					scroll === 'page'
						? 'pt-6 max-md:pt-3'
						: 'flex h-full min-h-0 flex-col max-md:h-auto max-md:min-h-full',
					contentClassName,
				)}
			>
				{children}
			</div>
		</div>
	);
}

export function PageHeader({
	children,
	actions,
	mobileActions = 'stack',
}: {
	children: ReactNode;
	actions?: ReactNode;
	mobileActions?: MobilePageActions;
}) {
	return (
		<div
			className={cn(
				'mb-4 flex shrink-0 items-center justify-between gap-4 max-md:gap-3',
				mobileActions === 'stack' ? 'max-md:flex-col' : 'flex-wrap',
			)}
		>
			<div
				className={cn(
					'flex min-w-0 items-center gap-2',
					mobileActions === 'stack' && 'max-md:w-full',
				)}
			>
				{children}
			</div>
			{actions && (
				<div
					className={cn(
						'shrink-0',
						mobileActions === 'stack' && 'max-md:w-full [&>*]:max-md:w-full',
					)}
				>
					{actions}
				</div>
			)}
		</div>
	);
}

export function ListContainer({ children }: { children: ReactNode }) {
	return <div className="flex flex-col overflow-hidden rounded-lg border bg-card">{children}</div>;
}
