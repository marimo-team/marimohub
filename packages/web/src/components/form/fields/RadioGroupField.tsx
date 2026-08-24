import { Label, RadioButton, RadioField, RadioGroup } from 'react-aria-components';
import { cn } from '@/lib/utils';
import { useFieldContext } from '../form-context';

export interface RadioGroupFieldOption {
	value: string;
	label: string;
	description?: string;
	isDisabled?: boolean;
}

export interface RadioGroupFieldProps {
	label?: string;
	options: RadioGroupFieldOption[];
}

/** A single-choice radio list bound to its enclosing `form.AppField`. */
export function RadioGroupField({ label, options }: RadioGroupFieldProps) {
	const field = useFieldContext<string>();
	return (
		<RadioGroup
			value={field.state.value}
			onChange={field.handleChange}
			className="flex flex-col gap-1.5"
		>
			{label && <Label className="text-xs font-medium text-muted-foreground">{label}</Label>}
			<div className="flex flex-col gap-1">
				{options.map((option) => (
					<RadioField key={option.value} value={option.value} isDisabled={option.isDisabled}>
						<RadioButton
							className={({ isSelected, isFocusVisible }) =>
								cn(
									'flex w-full cursor-pointer items-start gap-2.5 rounded-md border border-input px-3 py-2 text-sm transition-colors',
									isSelected ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
									isFocusVisible && 'ring-2 ring-ring ring-offset-2 ring-offset-background',
									option.isDisabled && 'cursor-not-allowed opacity-60',
								)
							}
						>
							{({ isSelected }) => (
								<>
									<span
										className={cn(
											'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors',
											isSelected ? 'border-primary' : 'border-input',
										)}
									>
										{isSelected && <span className="size-2 rounded-full bg-primary" />}
									</span>
									<span className="flex min-w-0 flex-col">
										<span className="truncate text-foreground">{option.label}</span>
										{option.description && (
											<span className="whitespace-normal break-words text-xs leading-4 text-muted-foreground">
												{option.description}
											</span>
										)}
									</span>
								</>
							)}
						</RadioButton>
					</RadioField>
				))}
			</div>
		</RadioGroup>
	);
}
