import type { SessionRender } from '../../ports/integrations';
import type { RenderedIntegration } from './bundle';
import { sortIntegrationsByName } from './ordering';

type PresentationBundle = Pick<SessionRender, 'files' | 'marimoPresentation'>;

export function composePresentation(
	rendered: readonly RenderedIntegration[],
	directory: string,
): PresentationBundle {
	const files: SessionRender['files'] = [];
	const cssFiles: string[] = [];
	const heads: string[] = [];
	for (const item of sortIntegrationsByName(rendered)) {
		const content = item.output.presentation;
		if (content?.css !== undefined) {
			const path = `${directory}/presentation/${item.name}.css`;
			files.push({ path, content: content.css });
			cssFiles.push(path);
		}
		if (content?.htmlHead !== undefined) heads.push(content.htmlHead);
	}
	const htmlHeadFile = heads.length > 0 ? `${directory}/presentation/head.html` : undefined;
	if (htmlHeadFile) files.push({ path: htmlHeadFile, content: heads.join('\n') });
	return {
		files,
		...(files.length > 0
			? {
					marimoPresentation: {
						...(cssFiles.length > 0 ? { cssFiles } : {}),
						...(htmlHeadFile ? { htmlHeadFile } : {}),
					},
				}
			: {}),
	};
}
