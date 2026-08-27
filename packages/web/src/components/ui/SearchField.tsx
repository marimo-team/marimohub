import type { Ref } from 'react';
import { SearchField as AriaSearchField, Input, Button, Label } from 'react-aria-components';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SearchFieldBaseProps {
	value?: string;
	defaultValue?: string;
	onChange?: (value: string) => void;
	name?: string;
	placeholder?: string;
	/** Forwarded to the input so a page-level hotkey can focus it. */
	inputRef?: Ref<HTMLInputElement>;
	className?: string;
}

type SearchFieldAccessibleName =
	| { label: string; 'aria-label'?: never }
	| { label?: never; 'aria-label': string };

export type SearchFieldProps = SearchFieldBaseProps & SearchFieldAccessibleName;

/** Search input with clear and Escape-to-clear behavior from React Aria. */
export function SearchField({
	value,
	defaultValue,
	onChange,
	name,
	label,
	placeholder,
	inputRef,
	className,
	...props
}: SearchFieldProps) {
	return (
		<AriaSearchField
			aria-label={label ? undefined : props['aria-label']}
			value={value}
			defaultValue={defaultValue}
			onChange={onChange}
			name={name}
			className={cn('group flex flex-col gap-1.5', className)}
		>
			{label ? <Label className="text-xs font-medium text-muted-foreground">{label}</Label> : null}
			<div className="relative">
				<Search
					className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
					aria-hidden
				/>
				<Input
					ref={inputRef}
					placeholder={placeholder}
					autoComplete="off"
					className={cn(
						'h-10 w-full rounded-lg border border-input bg-card pl-9 pr-10 text-sm text-foreground shadow-xs transition-[border-color,box-shadow] max-md:h-11',
						'placeholder:text-muted-foreground hover:border-ring/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
						'[&::-webkit-search-cancel-button]:appearance-none',
					)}
				/>
				{/* The `/` focus hotkey swaps for the clear button once the input has a value. */}
				<kbd
					aria-hidden
					className="pointer-events-none absolute right-2.5 top-1/2 hidden h-5 -translate-y-1/2 items-center rounded border bg-muted px-1.5 font-mono text-[11px] text-muted-foreground group-data-[empty]:flex"
				>
					/
				</kbd>
				<Button
					aria-label="Clear search"
					className={cn(
						'absolute right-1 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded text-muted-foreground outline-none transition-colors max-md:size-10',
						'hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
						'group-data-[empty]:hidden',
					)}
				>
					<X className="size-4" aria-hidden />
				</Button>
			</div>
		</AriaSearchField>
	);
}
