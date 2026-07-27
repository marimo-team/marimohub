import { AlertTriangle } from 'lucide-react';

/** The server keeps only a hash — this is the one render carrying the plaintext. */
export function WriteOnceWarning() {
	return (
		<div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
			<AlertTriangle className="mt-px size-4 shrink-0" />
			<span>Copy this token now — it is shown once and cannot be retrieved later.</span>
		</div>
	);
}
