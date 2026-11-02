import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { PageContainer, PageHeader } from './PageLayout';
import type { MobilePageActions, PageScroll, PageWidth } from './PageLayout';
import { PageTitle } from './PageTitle';

export interface PageProps {
	title: string;
	subtitle?: ReactNode;
	context?: string;
	actions?: ReactNode;
	titleActions?: ReactNode;
	leading?: ReactNode;
	children: ReactNode;
	width?: PageWidth;
	// Panel pages keep desktop scrolling inside their panes; mobile uses page scrolling.
	scroll?: PageScroll;
	mobileActions?: MobilePageActions;
	documentTitle?: string;
}

export function Page({
	title,
	subtitle,
	context,
	actions,
	titleActions,
	leading,
	children,
	width = 'normal',
	scroll = 'page',
	mobileActions = 'stack',
	documentTitle = context ? `${title} · ${context}` : title,
}: PageProps) {
	return (
		<PageContainer width={width} scroll={scroll}>
			<PageTitle>{documentTitle}</PageTitle>
			<PageHeader actions={actions} mobileActions={mobileActions}>
				{leading && <div className="shrink-0">{leading}</div>}
				<div className="min-w-0 max-w-full">
					{context && (
						<p className="mb-1 truncate text-xs font-medium text-muted-foreground" title={context}>
							{context}
						</p>
					)}
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
						<h1 className="min-w-0 break-words text-2xl font-semibold tracking-tight">{title}</h1>
						{titleActions && <div className="flex shrink-0 items-center gap-1">{titleActions}</div>}
					</div>
					{subtitle && <div className="mt-1 text-sm text-muted-foreground">{subtitle}</div>}
				</div>
			</PageHeader>
			<div className={cn('min-w-0', scroll === 'panels' && 'flex min-h-0 flex-1 flex-col gap-4')}>
				{children}
			</div>
		</PageContainer>
	);
}
