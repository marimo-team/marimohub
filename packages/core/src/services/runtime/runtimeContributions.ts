import type { RuntimeContributions } from '../../ports/integrations';
import { mergePresentationFiles } from './presentation';

export function mergeRuntimeContributions(
	...layers: (RuntimeContributions | undefined)[]
): RuntimeContributions {
	const runtimePackages = layers.flatMap((layer) => layer?.runtimePackages ?? []);
	const startupScripts = layers.flatMap((layer) => layer?.startupScripts ?? []);
	const marimoPresentation = mergePresentationFiles(
		...layers.map((layer) => layer?.marimoPresentation),
	);
	return {
		...(marimoPresentation ? { marimoPresentation } : {}),
		...(layers.some((layer) => layer?.workspaceLoadMode === 'copy-only')
			? { workspaceLoadMode: 'copy-only' as const }
			: {}),
		...(runtimePackages.length > 0 ? { runtimePackages } : {}),
		...(startupScripts.length > 0 ? { startupScripts } : {}),
	};
}
