import {
	Button,
	Label,
	ListBox,
	ListBoxItem,
	Popover,
	Select as AriaSelect,
	SelectValue,
} from 'react-aria-components';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SelectOption {
	id: string;
	label: string;
}

export function Select({
	label,
	value,
	options,
	onChange,
	className,
}: {
	label: string;
	value: string;
	options: SelectOption[];
	onChange: (value: string) => void;
	className?: string;
}) {
	return (
		<AriaSelect
			value={value}
			onChange={(key) => {
				if (typeof key === 'string') onChange(key);
			}}
			className={cn('flex min-w-0 flex-col gap-1.5', className)}
		>
			<Label className="text-xs font-medium text-muted-foreground">{label}</Label>
			<Button className="flex h-10 w-full items-center gap-2 rounded-lg border border-input bg-background px-3 text-left text-sm text-foreground shadow-xs outline-none transition-colors hover:border-ring/60 data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring data-[pressed]:bg-accent max-md:h-11">
				<SelectValue className="min-w-0 flex-1 truncate" />
				<ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
			</Button>
			<Popover
				placement="bottom start"
				offset={6}
				className="z-50 w-(--trigger-width) max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg"
			>
				<ListBox
					items={options}
					className="max-h-64 overflow-y-auto overscroll-contain p-1 outline-none"
				>
					{(option) => (
						<ListBoxItem
							id={option.id}
							textValue={option.label}
							className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm outline-none data-[focused]:bg-accent data-[focused]:text-accent-foreground max-md:min-h-11"
						>
							{({ isSelected }) => (
								<>
									<span className="min-w-0 flex-1 break-words">{option.label}</span>
									{isSelected && <Check className="size-4 shrink-0 text-primary" aria-hidden />}
								</>
							)}
						</ListBoxItem>
					)}
				</ListBox>
			</Popover>
		</AriaSelect>
	);
}
