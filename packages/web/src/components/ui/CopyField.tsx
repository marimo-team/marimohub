import { Check, Copy } from 'lucide-react';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { IconButton } from './IconButton';

export interface CopyFieldProps {
	/** Names the input for assistive tech, and captions it unless `hideLabel`. */
	label: string;
	value: string;
	/** The copy button's label; defaults to `Copy <label>`. */
	copyLabel?: string;
	hideLabel?: boolean;
}

/**
 * A read-only value with a copy button — sync URLs, sync tokens, API tokens.
 * Selecting on focus keeps a manual copy to one keystroke, for when the
 * clipboard API is unavailable (insecure context, denied permission).
 */
export function CopyField({ label, value, copyLabel, hideLabel }: CopyFieldProps) {
	const { copied, copy } = useCopyToClipboard();

	const row = (
		<div className="flex items-center gap-2">
			<input
				readOnly
				aria-label={label}
				value={value}
				onFocus={(e) => e.target.select()}
				className="h-9 w-full rounded-md border border-input bg-muted/40 px-3 font-mono text-xs text-foreground outline-none"
			/>
			<IconButton
				label={copied ? 'Copied' : (copyLabel ?? `Copy ${label.toLowerCase()}`)}
				onPress={() => void copy(value)}
			>
				{copied ? <Check className="size-4 text-primary" /> : <Copy className="size-4" />}
			</IconButton>
		</div>
	);

	if (hideLabel) return row;

	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-xs font-medium text-muted-foreground">{label}</span>
			{row}
		</div>
	);
}
