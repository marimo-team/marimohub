import { TokenFieldValue } from 'react-aria-components/TokenField';
import type { TokenFieldSegment } from 'react-aria-components/TokenField';

export class TagFieldValue extends TokenFieldValue {
	static fromTags(tags: readonly string[]): TagFieldValue {
		return new TagFieldValue(tags.map((text) => ({ type: 'token', text })));
	}

	protected override tokenize(text: string): TokenFieldSegment[] {
		const parts = text.split(/[,\r\n]/);
		return parts.flatMap<TokenFieldSegment>((part, index) => {
			if (index === parts.length - 1) return part ? [{ type: 'text', text: part }] : [];
			const tag = part.trim();
			return tag ? [{ type: 'token', text: tag }] : [];
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
