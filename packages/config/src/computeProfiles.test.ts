import { describe, expect, it } from 'vitest';
import {
	ComputeProfileConfigError,
	hasConfiguredResources,
	parseComputeProfiles,
	parseComputeProfileOverride,
	resolveResources,
	profilesForBackend,
	supportsComputeProfiles,
	supportsGpuProfiles,
	unsupportedBackendNotice,
} from './computeProfiles';
import { isConfigError } from './errors';

const Gi = 1024 ** 3;
const Mi = 1024 ** 2;

describe('parseComputeProfiles', () => {
	it('returns no profiles when unset, empty, or whitespace', () => {
		for (const raw of [undefined, '', '   ']) {
			const config = parseComputeProfiles(raw);
			expect(config.profiles).toHaveLength(0);
			expect(config.defaultProfile).toBeUndefined();
			expect(resolveResources(config)).toEqual({});
			expect(hasConfiguredResources(config)).toBe(false);
		}
	});

	it('parses ordered profiles and uses the first as the default', () => {
		const config = parseComputeProfiles('small:cpu=1;mem=2Gi,large:cpu=8;mem=32Gi');
		expect(config.profiles).toEqual([
			{ name: 'small', resources: { cpu: 1, memoryBytes: 2 * Gi } },
			{ name: 'large', resources: { cpu: 8, memoryBytes: 32 * Gi } },
		]);
		expect(resolveResources(config)).toEqual({ cpu: 1, memoryBytes: 2 * Gi });
		expect(resolveResources(parseComputeProfiles('large:cpu=8,small:cpu=1')).cpu).toBe(8);
	});

	it('preserves profile order and accepts every resource-key ordering', () => {
		const keyOrderings = [
			'cpu=8;mem=32Gi;gpu=A100',
			'cpu=8;gpu=A100;mem=32Gi',
			'mem=32Gi;cpu=8;gpu=A100',
			'mem=32Gi;gpu=A100;cpu=8',
			'gpu=A100;cpu=8;mem=32Gi',
			'gpu=A100;mem=32Gi;cpu=8',
		];
		for (const body of keyOrderings) {
			expect(parseComputeProfiles(`first:${body},second:gpu=T4`).profiles).toEqual([
				{ name: 'first', resources: { cpu: 8, memoryBytes: 32 * Gi, gpu: 'A100' } },
				{ name: 'second', resources: { gpu: 'T4' } },
			]);
		}
	});

	it('tolerates whitespace and trailing semicolons', () => {
		const config = parseComputeProfiles(
			'  small : gpu = a100:2 ; mem = 512Mi ; cpu = 0.5 ; , large:cpu=2 ',
		);
		expect(config.profiles[0].resources).toEqual({
			cpu: 0.5,
			memoryBytes: 512 * Mi,
			gpu: 'A100:2',
		});
		expect(config.profiles[1].resources).toEqual({ cpu: 2 });
	});

	it('allows fractional cpu and partial or empty profiles', () => {
		const config = parseComputeProfiles('tiny:cpu=0.25,mem-only:mem=1Gi,bare');
		expect(config.profiles[0].resources).toEqual({ cpu: 0.25 });
		expect(config.profiles[1].resources).toEqual({ memoryBytes: Gi });
		expect(config.profiles[2]).toEqual({ name: 'bare', resources: {} });
	});

	it('parses Mi, Gi, and Ti with decimals', () => {
		const config = parseComputeProfiles('a:mem=1536Mi,b:mem=1.5Gi,c:mem=2Ti');
		expect(config.profiles[0].resources.memoryBytes).toBe(1536 * Mi);
		expect(config.profiles[1].resources.memoryBytes).toBe(1.5 * Gi);
		expect(config.profiles[2].resources.memoryBytes).toBe(2 * 1024 ** 4);
	});

	it('parses and canonicalizes GPU types with optional counts', () => {
		const config = parseComputeProfiles(
			'gpu-a100:cpu=8;mem=32Gi;gpu=a100,gpu-t4:gpu=t4:2,gpu-large:gpu=A100-80gb:4',
		);
		expect(config.profiles).toEqual([
			{ name: 'gpu-a100', resources: { cpu: 8, memoryBytes: 32 * Gi, gpu: 'A100' } },
			{ name: 'gpu-t4', resources: { gpu: 'T4:2' } },
			{ name: 'gpu-large', resources: { gpu: 'A100-80GB:4' } },
		]);
		expect(resolveResources(config)).toEqual({ cpu: 8, memoryBytes: 32 * Gi, gpu: 'A100' });
		expect(hasConfiguredResources(config)).toBe(true);
		expect(profilesForBackend('modal', config)).toBe(config);
		const dockerConfig = profilesForBackend('docker', config);
		expect(dockerConfig.profiles).toEqual([
			{ name: 'gpu-a100', resources: { cpu: 8, memoryBytes: 32 * Gi } },
			{ name: 'gpu-t4', resources: {} },
			{ name: 'gpu-large', resources: {} },
		]);
		expect(dockerConfig.defaultProfile).toBe(dockerConfig.profiles[0]);
		expect(config.profiles[0].resources.gpu).toBe('A100');
	});

	it('accepts exact numeric resource boundaries', () => {
		expect(
			parseComputeProfiles('max:cpu=4096;mem=64Ti;gpu=A100:4294967295').defaultProfile?.resources,
		).toEqual({ cpu: 4096, memoryBytes: 64 * 1024 ** 4, gpu: 'A100:4294967295' });
	});

	const fatal = (raw: string, messagePart: string) => {
		let error: unknown;
		try {
			parseComputeProfiles(raw);
		} catch (cause) {
			error = cause;
		}
		expect(error).toBeInstanceOf(ComputeProfileConfigError);
		expect(isConfigError(error)).toBe(true);
		expect((error as Error).message).toContain(messagePart);
	};

	it('rejects unknown keys', () => {
		fatal('small:cpus=1', 'unknown key');
		fatal('small:memory=2Gi', 'unknown key');
		fatal('big:disk=10Gi', 'unknown key');
	});

	it('rejects malformed GPU requests', () => {
		for (const value of [
			'A100:',
			'A100:0',
			'A100:01',
			'A100:+1',
			'A100:-1',
			'A100:1.5',
			'A100:1e2',
			'A100::2',
			'A100:2:3',
			'A100 80GB',
			'A100-',
			'-A100',
			':1',
			'A100=2',
		]) {
			fatal(`gpu:gpu=${value}`, 'gpu must match');
		}
		fatal('gpu:gpu=A100:4294967296', 'transport limit');
		fatal('gpu:gpu=A100:999999999999999999999999999999999999', 'transport limit');
	});

	it('rejects unsupported or missing memory units', () => {
		fatal('small:mem=4', 'explicit binary unit');
		fatal('small:mem=4GB', 'binary units Mi, Gi, or Ti');
		fatal('small:mem=4GiB', 'binary units Mi, Gi, or Ti');
		fatal('small:mem=4g', 'binary units Mi, Gi, or Ti');
	});

	it('rejects malformed and non-positive values', () => {
		for (const value of ['abc', '-1', '+1', '.5', '1.', '1e2', 'Infinity', 'NaN']) {
			fatal(`small:cpu=${value}`, 'positive decimal');
		}
		for (const value of ['abcGi', '-1Gi', '+1Gi', '.5Gi', '1.Gi', '1e2Gi']) {
			fatal(`small:mem=${value}`, 'mem');
		}
		for (const value of ['0', '0.0004']) fatal(`small:cpu=${value}`, 'at least 0.001');
		for (const value of ['0Gi', '0.0000001Mi', '0.5Mi']) {
			fatal(`small:mem=${value}`, 'at least 1Mi');
		}
	});

	it('accepts the smallest provider-representable values', () => {
		expect(parseComputeProfiles('tiny:cpu=0.001;mem=1Mi').defaultProfile?.resources).toEqual({
			cpu: 0.001,
			memoryBytes: Mi,
		});
	});

	it('rejects values beyond sanity ceilings', () => {
		fatal('huge:cpu=9999', 'sanity limit');
		fatal('huge:mem=999Ti', 'sanity limit');
	});

	it('rejects duplicate keys and names', () => {
		fatal('small:cpu=1;cpu=2', 'duplicate key');
		fatal('small:gpu=A100;gpu=T4', 'duplicate key');
		fatal('small:cpu=1,small:cpu=2', 'duplicate profile name');
		fatal(' small:cpu=1 , small:cpu=2 ', 'duplicate profile name');
	});

	it('rejects invalid names', () => {
		const maxName = 'a'.repeat(32);
		expect(parseComputeProfiles(`${maxName}:gpu=A100`).profiles[0].name).toBe(maxName);
		fatal('Small:cpu=1', 'invalid profile name');
		fatal('has_underscore:cpu=1', 'invalid profile name');
		fatal(`${'a'.repeat(33)}:cpu=1`, 'invalid profile name');
		fatal(':cpu=1', 'empty name');
		fatal('small:cpu=1,,large:cpu=2', 'position 2 has an empty name');
		fatal(',small:cpu=1', 'position 1 has an empty name');
		fatal('small:cpu=1,', 'position 2 has an empty name');
	});

	it('rejects missing keys or values', () => {
		fatal('small:cpu', 'expected key=value');
		fatal('small:cpu=', 'empty value');
		fatal('small:=1', 'unknown key');
		fatal('small:gpu=A100=2', 'gpu must match');
		fatal('small:GPU=A100', 'unknown key');
	});

	it('allows one trailing separator but rejects empty resource entries elsewhere', () => {
		expect(parseComputeProfiles('small:cpu=1;').defaultProfile?.resources).toEqual({ cpu: 1 });
		fatal('small:;cpu=1', 'empty resource entry');
		fatal('small:cpu=1;;gpu=A100', 'empty resource entry');
		fatal('small:cpu=1;;', 'empty resource entry');
	});

	it('names the offending profile and key in the error', () => {
		let error: ComputeProfileConfigError | undefined;
		try {
			parseComputeProfiles('small:cpu=1,large:mem=4GB');
		} catch (cause) {
			error = cause as ComputeProfileConfigError;
		}
		expect(error?.profileName).toBe('large');
		expect(error?.key).toBe('mem');
		expect(error?.message).toContain('"large"');
	});
});

describe('parseComputeProfileOverride', () => {
	it('defaults to none and accepts editors', () => {
		expect(parseComputeProfileOverride(undefined)).toBe('none');
		expect(parseComputeProfileOverride('')).toBe('none');
		expect(parseComputeProfileOverride('none')).toBe('none');
		expect(parseComputeProfileOverride('editors')).toBe('editors');
	});

	it('rejects unknown values', () => {
		expect(() => parseComputeProfileOverride('all')).toThrow(/MARIMOHUB_COMPUTE_PROFILE_OVERRIDE/);
	});
});

describe('unsupportedBackendNotice', () => {
	it('returns a notice only when non-empty resources are configured', () => {
		const configured = parseComputeProfiles('small:cpu=1');
		expect(unsupportedBackendNotice('e2b', configured)).toContain('ignored');
		expect(unsupportedBackendNotice('e2b', parseComputeProfiles(undefined))).toBeUndefined();
		expect(unsupportedBackendNotice('local', parseComputeProfiles('bare'))).toBeUndefined();
	});

	it('includes an ignored editor-override policy even without resource values', () => {
		const notice = unsupportedBackendNotice('local', parseComputeProfiles(undefined), 'editors');
		expect(notice).toContain('MARIMOHUB_COMPUTE_PROFILE_OVERRIDE');
		expect(notice).toContain('ignored');
	});

	it('warns when a profile-aware backend ignores only GPU values', () => {
		const configured = parseComputeProfiles('gpu:cpu=8;gpu=A100');
		expect(unsupportedBackendNotice('docker', configured)).toContain('profile GPUs');
		expect(unsupportedBackendNotice('docker', configured)).toContain(
			'CPU and memory values still apply',
		);
		expect(unsupportedBackendNotice('modal', configured)).toBeUndefined();
		expect(unsupportedBackendNotice('docker', parseComputeProfiles('small:cpu=1'))).toBeUndefined();
	});
});

describe('supportsComputeProfiles', () => {
	it('only enables profile UX for adapters that apply resource requests', () => {
		for (const backend of ['coreweave', 'wandb', 'modal', 'docker', 'podman', 'kubernetes']) {
			expect(supportsComputeProfiles(backend), backend).toBe(true);
		}
		for (const backend of ['e2b', 'cloudflare', 'local', 'none', 'noop', 'unknown']) {
			expect(supportsComputeProfiles(backend), backend).toBe(false);
		}
	});

	it('only maps profile GPUs on Modal', () => {
		expect(supportsGpuProfiles('modal')).toBe(true);
		for (const backend of [
			'coreweave',
			'wandb',
			'docker',
			'podman',
			'kubernetes',
			'e2b',
			'cloudflare',
			'local',
		]) {
			expect(supportsGpuProfiles(backend), backend).toBe(false);
		}
	});
});
