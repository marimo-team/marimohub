import type { RuntimeContributions } from '../../ports/integrations';
import { mergePresentationFiles } from './presentation';

export function mergeRuntimeContributions(
	...layers: (RuntimeContributions | undefined)[]
): RuntimeContributions {
	const runtimePackages = layers.flatMap((layer) => layer?.runtimePackages ?? []);
	const startupScripts = layers.flatMap((layer) => layer?.startupScripts ?? []);
	const logging = layers.flatMap((layer) => layer?.logging ?? []);
	const marimoPresentation = mergePresentationFiles(
		...layers.map((layer) => layer?.marimoPresentation),
	);
	return {
		...(logging.length > 0 ? { logging } : {}),
		...(marimoPresentation ? { marimoPresentation } : {}),
		...(layers.some((layer) => layer?.workspaceLoadMode === 'copy-only')
			? { workspaceLoadMode: 'copy-only' as const }
			: {}),
		...(runtimePackages.length > 0 ? { runtimePackages } : {}),
		...(startupScripts.length > 0 ? { startupScripts } : {}),
	};
}
