import { ContainerCompute, spawnContainerRunner } from './index';
import type { ContainerConfig, ContainerRunner } from './index';

export type {
	ContainerConfig as DockerConfig,
	ContainerRunner as DockerRunner,
	ContainerRunResult as DockerRunResult,
} from './index';

export function spawnDockerRunner(bin = 'docker'): ContainerRunner {
	return spawnContainerRunner(bin);
}

export class DockerCompute extends ContainerCompute {
	constructor(config: ContainerConfig = {}, runner: ContainerRunner = spawnDockerRunner()) {
		super('docker', config, runner);
	}
}
