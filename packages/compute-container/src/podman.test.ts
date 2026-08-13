import { computeContract } from '@marimo-hub/core/testing/compute-contract';
import { PodmanCompute, spawnPodmanRunner } from './podman';
import { containerCliContract } from './testing';
import type { PodmanRunResult, PodmanRunner } from './podman';

function fakeRunner(): PodmanRunner {
	return {
		async run(args): Promise<PodmanRunResult> {
			if (args[0] === 'inspect') return { stdout: '', stderr: 'not found', exitCode: 1 };
			if (args[0] === 'port') {
				return { stdout: '127.0.0.1:49153\n', stderr: '', exitCode: 0 };
			}
			if (args.at(-1) === 'false') return { stdout: '', stderr: 'failed', exitCode: 1 };
			return { stdout: '', stderr: '', exitCode: 0 };
		},
	};
}

containerCliContract(
	'PodmanCompute',
	'podman',
	(config, runner) => new PodmanCompute(config, runner),
	spawnPodmanRunner,
);

computeContract('PodmanCompute', () => new PodmanCompute({}, fakeRunner()), {
	mountFallsBack: true,
	semantics: { failingCommand: 'false' },
});
