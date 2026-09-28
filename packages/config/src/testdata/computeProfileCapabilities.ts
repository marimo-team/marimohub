import type { SandboxProvider } from '@marimo-hub/core';

export const libraryProfileCases: [
	name: string,
	capabilities: SandboxProvider['capabilities'],
	computeProfiles: boolean,
	gpuProfiles: boolean,
][] = [
	['no capabilities', undefined, false, false],
	['no profile flags', { multiPort: true }, false, false],
	[
		'disabled profiles',
		{ multiPort: false, computeProfiles: false, gpuProfiles: false },
		false,
		false,
	],
	['CPU and memory only', { multiPort: false, computeProfiles: true }, true, false],
	['CPU and GPU', { multiPort: false, computeProfiles: true, gpuProfiles: true }, true, true],
	['GPU implies CPU', { multiPort: false, gpuProfiles: true }, true, true],
	[
		'GPU overrides disabled CPU profiles',
		{ multiPort: false, computeProfiles: false, gpuProfiles: true },
		true,
		true,
	],
];
