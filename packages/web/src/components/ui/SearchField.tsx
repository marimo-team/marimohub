import type { Ref } from 'react';
import { SearchField as AriaSearchField, Input, Button } from 'react-aria-components';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SearchFieldProps {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	/** Accessible name — required, since a search box has no visible label. */
	'aria-label': string;
	/** Forwarded to the underlying input so a hotkey can focus it. */
	inputRef?: Ref<HTMLInputElement>;
	className?: string;
}

/**
 * A labeled search box on react-aria `SearchField`, which provides the clear (✕)
 * button, Escape-to-clear, and `searchbox` role.
 */
export function SearchField({
	value,
	onChange,
	placeholder,
	inputRef,
	className,
	...props
}: SearchFieldProps) {
	return (
		<AriaSearchField
			aria-label={props['aria-label']}
			value={value}
			onChange={onChange}
			className={cn('group relative', className)}
		>
			<Search
				className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
				aria-hidden
			/>
			<Input
				ref={inputRef}
				placeholder={placeholder}
				className={cn(
					'h-10 w-full rounded-lg border border-input bg-card pl-9 pr-9 text-sm text-foreground shadow-xs transition-[border-color,box-shadow]',
					'placeholder:text-muted-foreground hover:border-ring/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
					'[&::-webkit-search-cancel-button]:appearance-none',
				)}
			/>
			{/* The `/` focus hotkey (useSearchHotkey); swaps for the clear button once there's a query. */}
			<kbd
				aria-hidden
				className="pointer-events-none absolute right-2.5 top-1/2 hidden h-5 -translate-y-1/2 items-center rounded border bg-muted px-1.5 font-mono text-[11px] text-muted-foreground group-data-[empty]:flex"
			>
				/
			</kbd>
			<Button
				aria-label="Clear search"
				className={cn(
					'absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground outline-none transition-colors',
					'hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
					'group-data-[empty]:hidden',
				)}
			>
				<X className="size-4" aria-hidden />
			</Button>
		</AriaSearchField>
	);
}
