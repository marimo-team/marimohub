import { Label, Text } from 'react-aria-components';
import { Token, TokenField, TokenFieldValue, TokenInput } from 'react-aria-components/TokenField';
import type { TokenFieldSegment } from 'react-aria-components/TokenField';

export class TagFieldValue extends TokenFieldValue {
	static fromTags(tags: readonly string[]): TagFieldValue {
		return new TagFieldValue(tags.map((text) => ({ type: 'token', text })));
	}

	protected override tokenize(text: string): TokenFieldSegment[] {
		const parts = text.split(/[,\r\n]/);
		return parts.flatMap<TokenFieldSegment>((part, index) => {
			if (index === parts.length - 1) return part ? [{ type: 'text', text: part }] : [];
			return part.trim() ? [{ type: 'token', text: part.trim() }] : [];
		});
	}

	get tags(): string[] {
		return this.segments.flatMap((segment) => {
			const tag = segment.type === 'token' ? segment.text : segment.text.trim();
			return tag ? [tag] : [];
		});
	}

	override toString(): string {
		return this.tags.join(', ');
	}
}

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
