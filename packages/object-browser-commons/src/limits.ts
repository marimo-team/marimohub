export interface ObjectBrowserLimits {
	metadataMaxResponseBytes: number;
	listMaxResponseBytes: number;
	previewMaxBytes: number;
	inlineImageMaxBytes: number;
	parquetMaxRangedBytes: number;
	searchMaxKeys: number;
	metadataTimeoutMs: number;
	previewTimeoutMs: number;
}

export const DEFAULT_OBJECT_BROWSER_LIMITS: ObjectBrowserLimits = {
	metadataMaxResponseBytes: 1024 * 1024,
	// A search page can carry 1,000 max-length (1,024-char) keys; with escaping
	// and per-entry envelope that approaches 6.5 MiB, well past the metadata cap.
	listMaxResponseBytes: 8 * 1024 * 1024,
	previewMaxBytes: 8 * 1024 * 1024,
	inlineImageMaxBytes: 10 * 1024 * 1024,
	parquetMaxRangedBytes: 32 * 1024 * 1024,
	searchMaxKeys: 5_000,
	metadataTimeoutMs: 30_000,
	previewTimeoutMs: 30_000,
};
