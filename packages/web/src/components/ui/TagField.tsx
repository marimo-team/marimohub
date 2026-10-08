import type { TagFieldValue } from '@/lib/tagFieldValue';
import { Label, Text } from 'react-aria-components';
import { Token, TokenField, TokenInput } from 'react-aria-components/TokenField';

export function TagField({
	label,
	value,
	onChange,
	onBlur,
	description,
}: {
	label: string;
	value: TagFieldValue;
	onChange: (value: TagFieldValue) => void;
	onBlur?: () => void;
	description?: string;
}) {
	return (
		<TokenField
			value={value}
			onChange={onChange}
			onBlur={onBlur}
			allowsNewlines
			onSubmit={() => onChange(value.replaceRange(value.caretPosition, value.caretPosition, ','))}
			className="flex flex-col gap-1.5"
		>
			<Label className="text-xs font-medium text-muted-foreground">{label}</Label>
			<TokenInput className="min-h-9 w-full rounded-md border border-input bg-background px-2 py-1 text-sm leading-7 text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background wrap-anywhere">
				{(segment) => (
					<Token className="mx-0.5 inline rounded bg-muted px-1.5 py-0.5 text-sm text-foreground data-selected:bg-primary data-selected:text-primary-foreground">
						{segment.text}
					</Token>
				)}
			</TokenInput>
			{description && (
				<Text slot="description" className="text-xs text-muted-foreground">
					{description}
				</Text>
			)}
		</TokenField>
	);
}
