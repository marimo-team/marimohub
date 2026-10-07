import type { Project } from '@marimo-hub/core';
import type { WifConfig } from './context';

export type FederationSource = 'project' | 'deployment' | 'unavailable';

export interface EffectiveFederation {
	enabled: boolean;
	source: FederationSource;
}

/** A stored project override wins over the deployment default; neither applies without WIF. */
export function effectiveFederation(
	project: Pick<Project, 'federation'>,
	wif: WifConfig | undefined,
): EffectiveFederation {
	if (!wif) return { enabled: false, source: 'unavailable' };
	if (project.federation) return { enabled: project.federation.enabled, source: 'project' };
	return { enabled: wif.defaultEnabled, source: 'deployment' };
}

/**
 * The WIF config to mint credentials with for this project, or undefined when
 * federation does not apply. Restricted (viewer throwaway) sandboxes never federate.
 */
export function federationFor(
	project: Pick<Project, 'federation'>,
	wif: WifConfig | undefined,
	options: { restricted?: boolean } = {},
): WifConfig | undefined {
	if (options.restricted) return undefined;
	return effectiveFederation(project, wif).enabled ? wif : undefined;
}
