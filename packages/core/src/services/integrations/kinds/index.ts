import { IntegrationRegistry } from '../registry';
import * as definitions from './definitions';

export * from './definitions';

export function defaultRegistry(): IntegrationRegistry {
	const registry = new IntegrationRegistry();
	for (const definition of Object.values(definitions)) registry.register(definition);
	return registry;
}
