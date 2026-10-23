import type { RuntimeContributions } from '../../ports/integrations';

export function mergeRuntimeContributions(
	...layers: (RuntimeContributions | undefined)[]
): RuntimeContributions {
	const runtimePackages = layers.flatMap((layer) => layer?.runtimePackages ?? []);
	const startupScripts = layers.flatMap((layer) => layer?.startupScripts ?? []);
	return {
		...(layers.some((layer) => layer?.workspaceLoadMode === 'copy-only')
			? { workspaceLoadMode: 'copy-only' as const }
			: {}),
		...(runtimePackages.length > 0 ? { runtimePackages } : {}),
		...(startupScripts.length > 0 ? { startupScripts } : {}),
	};
}
