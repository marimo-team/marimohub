export function parseSandboxAssetUrl(raw: string | undefined): string | undefined {
	const value = raw?.trim() ?? 'hub';
	return value.toLowerCase() === 'false' ? undefined : value || undefined;
}
