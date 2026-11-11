import { parseAssetBaseUrl } from '@marimo-hub/core/url';

export function publicMarimoAssetUrl(value: string | undefined): string | undefined {
	return parseAssetBaseUrl(value) ? value : undefined;
}
