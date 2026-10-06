import { ContainerCompute, spawnContainerRunner } from './index';
import type { ContainerConfig, ContainerRunner } from './index';

export type {
	ContainerConfig as PodmanConfig,
	ContainerRunner as PodmanRunner,
	ContainerRunResult as PodmanRunResult,
} from './index';

export function spawnPodmanRunner(bin = 'podman'): ContainerRunner {
	return spawnContainerRunner(bin);
}

export class PodmanCompute extends ContainerCompute {
	constructor(config: ContainerConfig = {}, runner: ContainerRunner = spawnPodmanRunner()) {
		super('podman', config, runner);
	}
}
