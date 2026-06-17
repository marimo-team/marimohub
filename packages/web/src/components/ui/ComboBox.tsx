import type { ReactNode } from 'react';
import {
	ComboBox as AriaComboBox,
	Input,
	Label,
	ListBox,
	ListBoxItem,
	Popover as AriaPopover,
} from 'react-aria-components';
import { cn } from '@/lib/utils';

export interface ComboBoxOption {
	/** Stable option key, passed to `onSelect`. */
	id: string;
	/** Plain-text value for typeahead/announcements. */
	textValue: string;
}

export interface ComboBoxProps<T extends ComboBoxOption> {
	label?: string;
	'aria-label'?: string;
	placeholder?: string;
	/** Controlled text: the caller derives its options (e.g. a search) from it. */
	inputValue: string;
	onInputChange: (value: string) => void;
	options: T[];
	onSelect: (id: string) => void;
	/** Rendered inside each option row. */
	renderOption: (option: T) => ReactNode;
	/** Shown in the popover while options are empty (e.g. "Searching…"). */
	emptyState?: ReactNode;
	isDisabled?: boolean;
	autoFocus?: boolean;
	className?: string;
}

/**
 * A searchable option picker over react-aria-components' ComboBox, styled to
 * match {@link TextField}/{@link DropdownMenu}. Free text is allowed — the
 * caller owns the input value and typically mixes async search results with
 * synthetic options derived from the raw text. Selection is momentary: picking
 * an option fires `onSelect` and nothing is held selected, so it behaves like
 * a command palette rather than a form select.
 */
export function ComboBox<T extends ComboBoxOption>({
	label,
	'aria-label': ariaLabel,
	placeholder,
	inputValue,
	onInputChange,
	options,
	onSelect,
	renderOption,
	emptyState,
	isDisabled,
	autoFocus,
	className,
}: ComboBoxProps<T>) {
	return (
		<AriaComboBox
			aria-label={ariaLabel}
			inputValue={inputValue}
			onInputChange={onInputChange}
			value={null}
			onChange={(key) => {
				if (typeof key === 'string') onSelect(key);
			}}
			items={options}
			allowsCustomValue
			allowsEmptyCollection={!!emptyState}
			menuTrigger="input"
			isDisabled={isDisabled}
			className={cn('flex flex-col gap-1.5', className)}
		>
			{label && <Label className="text-xs font-medium text-muted-foreground">{label}</Label>}
			<Input
				placeholder={placeholder}
				autoFocus={autoFocus}
				className={cn(
					'h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-sm transition-colors',
					'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
				)}
			/>
			<AriaPopover
				offset={4}
				className="z-50 w-(--trigger-width) rounded-md border bg-popover text-popover-foreground shadow-lg entering:animate-in entering:fade-in-0 exiting:animate-out exiting:fade-out-0"
			>
				<ListBox<T>
					className="max-h-64 overflow-auto p-1 text-sm outline-none"
					renderEmptyState={() => (
						<div className="px-2 py-1.5 text-muted-foreground">{emptyState}</div>
					)}
				>
					{(option) => (
						<ListBoxItem
							id={option.id}
							textValue={option.textValue}
							className="cursor-pointer rounded-sm px-2 py-1.5 outline-none data-[focused]:bg-accent data-[focused]:text-accent-foreground"
						>
							{renderOption(option)}
						</ListBoxItem>
					)}
				</ListBox>
			</AriaPopover>
		</AriaComboBox>
	);
}
