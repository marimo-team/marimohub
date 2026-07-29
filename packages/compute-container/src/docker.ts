import { ContainerCompute, spawnContainerRunner } from './index';

export interface DockerRunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface DockerRunner {
	run(args: string[], options?: { stdin?: string | Uint8Array }): Promise<DockerRunResult>;
}

export interface DockerConfig {
	image?: string;
	host?: string;
	bindHost?: string;
	network?: string;
	labelKey?: string;
}

export function spawnDockerRunner(bin = 'docker'): DockerRunner {
	return spawnContainerRunner(bin);
}

export class DockerCompute extends ContainerCompute {
	constructor(config: DockerConfig = {}, runner: DockerRunner = spawnDockerRunner()) {
		super('docker', config, runner);
	}
}
