/**
 * Trigger a browser "Save As" for an in-memory blob by clicking a transient
 * anchor. The object URL is revoked right after the click so it does not leak.
 */
export function triggerDownload(filename: string, blob: Blob): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = filename;
	document.body.append(anchor);
	anchor.click();
	anchor.remove();
	URL.revokeObjectURL(url);
}

/**
 * Make a notebook title safe to use as a download filename: collapse runs of
 * unsupported characters to underscores and fall back to `notebook` when the
 * title reduces to nothing.
 */
export function sanitizeFilename(name: string): string {
	const cleaned = name
		.trim()
		.replaceAll(/[^a-zA-Z0-9-_.]+/g, '_')
		.replaceAll(/^_+|_+$/g, '');
	return cleaned || 'notebook';
}
