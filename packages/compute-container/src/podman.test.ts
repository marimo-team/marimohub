import { NOT_A_DIRECTORY_EXIT_CODE, NOT_A_DIRECTORY_MARKER } from '@marimo-hub/compute-commons';
import type { SandboxId } from '@marimo-hub/core';
import { describe, expect, it } from 'vitest';
import {
	computeContract,
	isContractNonDirectoryFindCommand,
} from '@marimo-hub/core/testing/compute-contract';
import { portConnectorContract } from '@marimo-hub/core/testing/port-connector-contract';
import { PodmanCompute, spawnPodmanRunner } from './podman';
import { containerCliContract, contractLaunchCliHandler } from './testing';
import type { PodmanRunResult, PodmanRunner } from './podman';

function fakeRunner(): PodmanRunner {
	const launchHandler = contractLaunchCliHandler();
	return {
		async run(args): Promise<PodmanRunResult> {
			const launch = launchHandler(args);
			if (launch) return launch;
			if (args[0] === 'inspect') return { stdout: '', stderr: 'not found', exitCode: 1 };
			if (args[0] === 'port') {
				return { stdout: '127.0.0.1:49153\n', stderr: '', exitCode: 0 };
			}
			if (args.at(-1) === 'false') return { stdout: '', stderr: 'failed', exitCode: 1 };
			if (isContractNonDirectoryFindCommand(args.at(-1))) {
				return {
					stdout: '',
					stderr: NOT_A_DIRECTORY_MARKER,
					exitCode: NOT_A_DIRECTORY_EXIT_CODE,
				};
			}
			return { stdout: '', stderr: '', exitCode: 0 };
		},
	};
}

describe('PodmanCompute brokered ports', () => {
	it('disables brokered ports for remote Podman connections', async () => {
		const compute = new PodmanCompute(
			{ daemonHost: 'ssh://podman.example/run/podman.sock' },
			fakeRunner(),
		);

		expect(compute.brokeredPortConnectionsEnabled).toBe(false);
		await expect(compute.connectPort('sb-aaaaaaaaaaaaaaaa' as SandboxId, 2222)).rejects.toThrow(
			/remote daemon/,
		);
	});
});

containerCliContract(
	'PodmanCompute',
	'podman',
	(config, runner) => new PodmanCompute(config, runner),
	spawnPodmanRunner,
);

computeContract('PodmanCompute', () => new PodmanCompute({}, fakeRunner()), {
	mountFallsBack: true,
	semantics: { failingCommand: 'false', launch: {} },
});

portConnectorContract(
	'PodmanCompute',
	(publishedPort) =>
		new PodmanCompute(
			{ bindHost: '127.0.0.1' },
			{
				run: async (args) =>
					args[0] === 'port'
						? { stdout: `127.0.0.1:${publishedPort}\n`, stderr: '', exitCode: 0 }
						: { stdout: '', stderr: '', exitCode: 0 },
			},
		),
);
