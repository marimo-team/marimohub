import type { ReactNode } from 'react';
// Aliased: this file's own export is also named SwitchField.
import { SwitchButton, SwitchField as AriaSwitchField } from 'react-aria-components';
import { cn } from '@/lib/utils';
import { useFieldContext } from '../form-context';

export interface SwitchFieldProps {
	/** Renders the label/content beside the toggle, given the current state. */
	children: (isSelected: boolean) => ReactNode;
}

/** A boolean toggle bound to its enclosing `form.AppField`. */
export function SwitchField({ children }: SwitchFieldProps) {
	const field = useFieldContext<boolean>();
	return (
		<AriaSwitchField isSelected={field.state.value} onChange={field.handleChange}>
			<SwitchButton className="flex cursor-pointer items-center gap-3 outline-none">
				{({ isSelected }) => (
					<>
						<span
							className={cn(
								'relative h-5 w-9 shrink-0 rounded-full transition-colors',
								isSelected ? 'bg-primary' : 'bg-input',
							)}
						>
							<span
								className={cn(
									'absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-sm transition-transform',
									isSelected && 'translate-x-4',
								)}
							/>
						</span>
						{children(isSelected)}
					</>
				)}
			</SwitchButton>
		</AriaSwitchField>
	);
}
