import { ContainerCompute, spawnContainerRunner } from './index';

export interface PodmanRunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface PodmanRunner {
	run(
		args: string[],
		options?: { stdin?: string | Uint8Array; timeout?: number },
	): Promise<PodmanRunResult>;
}

export interface PodmanConfig {
	image?: string;
	host?: string;
	bindHost?: string;
	network?: string;
	labelKey?: string;
}

export function spawnPodmanRunner(bin = 'podman'): PodmanRunner {
	return spawnContainerRunner(bin);
}

export class PodmanCompute extends ContainerCompute {
	constructor(config: PodmanConfig = {}, runner: PodmanRunner = spawnPodmanRunner()) {
		super('podman', config, runner);
	}
}
