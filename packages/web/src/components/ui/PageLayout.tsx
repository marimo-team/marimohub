import type { ReactNode } from 'react';

/**
 * Centered, scrollable page body shared by the list views. Wraps content in the
 * standard max-width column.
 */
export function PageContainer({ children }: { children: ReactNode }) {
	return (
		<div className="flex flex-1 justify-center overflow-y-auto bg-muted/30 p-6 max-md:p-3">
			<div className="w-full max-w-2xl">{children}</div>
		</div>
	);
}

/**
 * The title-row of a page: a left cluster (title + inline controls, passed as
 * children) and an optional right-aligned `actions` slot. Stacks on mobile.
 */
export function PageHeader({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
	return (
		<div className="mb-6 flex items-center justify-between max-md:flex-col max-md:items-start max-md:gap-3">
			<div className="flex min-w-0 items-center gap-2 max-md:w-full">{children}</div>
			{actions && <div className="max-md:w-full [&>*]:max-md:w-full">{actions}</div>}
		</div>
	);
}

/** The bordered card that wraps a vertical list of rows. */
export function ListContainer({ children }: { children: ReactNode }) {
	return (
		<div className="flex flex-col overflow-hidden rounded-lg border bg-card shadow-sm">
			{children}
		</div>
	);
}
