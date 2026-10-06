import type { Project } from '@marimo-hub/core';
import type { WifConfig } from './context';

export function projectFederationEnabled(
	project: Pick<Project, 'federation'>,
	wif: WifConfig | undefined,
): boolean {
	return Boolean(wif && (project.federation?.enabled ?? wif.defaultEnabled ?? false));
}
