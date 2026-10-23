import { ValidationError } from '../../errors';
import type { PresentationFiles } from '../../ports/integrations';

export function mergePresentationFiles(
	...layers: (PresentationFiles | undefined)[]
): PresentationFiles | undefined {
	const cssFiles = [...new Set(layers.flatMap((layer) => layer?.cssFiles ?? []))];
	const heads = [
		...new Set(layers.flatMap((layer) => (layer?.htmlHeadFile ? [layer.htmlHeadFile] : []))),
	];
	if (heads.length > 1)
		throw new ValidationError('Cannot combine different bundled HTML head files.');
	if (cssFiles.length === 0 && heads.length === 0) return;
	return {
		...(cssFiles.length > 0 ? { cssFiles } : {}),
		...(heads.length > 0 ? { htmlHeadFile: heads[0] } : {}),
	};
}
