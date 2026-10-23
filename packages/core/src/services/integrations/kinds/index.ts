import { IntegrationRegistry } from '../registry';
import * as definitions from './definitions';

export * from './definitions';

export function defaultRegistry(): IntegrationRegistry {
	const registry = new IntegrationRegistry();
	const sorted = Object.values(definitions).sort((a, b) => a.kind.localeCompare(b.kind));
	for (const definition of sorted) registry.register(definition);
	return registry;
}
