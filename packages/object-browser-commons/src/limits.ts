export interface ObjectBrowserLimits {
	previewMaxBytes: number;
	inlineImageMaxBytes: number;
	parquetMaxRangedBytes: number;
	searchMaxKeys: number;
	metadataTimeoutMs: number;
	previewTimeoutMs: number;
}

export const DEFAULT_OBJECT_BROWSER_LIMITS: ObjectBrowserLimits = {
	previewMaxBytes: 8 * 1024 * 1024,
	inlineImageMaxBytes: 10 * 1024 * 1024,
	parquetMaxRangedBytes: 32 * 1024 * 1024,
	searchMaxKeys: 5_000,
	metadataTimeoutMs: 30_000,
	previewTimeoutMs: 30_000,
};
