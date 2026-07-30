import { describe, expect, it } from 'vitest';
import {
	ComputeProfileConfigError,
	hasConfiguredResources,
	parseComputeProfiles,
	parseComputeProfileOverride,
	resolveResources,
	supportsComputeProfiles,
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

	it('tolerates whitespace and trailing semicolons', () => {
		const config = parseComputeProfiles('  small : cpu = 0.5 ; mem = 512Mi ; , large:cpu=2 ');
		expect(config.profiles[0].resources).toEqual({
			cpu: 0.5,
			memoryBytes: 512 * Mi,
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
		fatal('gpu-a100:cpu=8;gpu=A100:1', 'unknown key');
		fatal('big:disk=10Gi', 'unknown key');
	});

	it('rejects unsupported or missing memory units', () => {
		fatal('small:mem=4', 'explicit binary unit');
		fatal('small:mem=4GB', 'binary units Mi, Gi, or Ti');
		fatal('small:mem=4GiB', 'binary units Mi, Gi, or Ti');
		fatal('small:mem=4g', 'binary units Mi, Gi, or Ti');
	});

	it('rejects malformed and non-positive values', () => {
		fatal('small:cpu=abc', 'positive decimal');
		fatal('small:cpu=0', 'at least 0.001');
		fatal('small:cpu=0.0004', 'at least 0.001');
		fatal('small:cpu=-1', 'positive decimal');
		fatal('small:mem=0Gi', 'at least 1Mi');
		fatal('small:mem=0.0000001Mi', 'at least 1Mi');
		fatal('small:mem=0.5Mi', 'at least 1Mi');
		fatal('small:mem=abcGi', 'must match');
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
		fatal('small:cpu=1,small:cpu=2', 'duplicate profile name');
	});

	it('rejects invalid names', () => {
		fatal('Small:cpu=1', 'invalid profile name');
		fatal('has_underscore:cpu=1', 'invalid profile name');
		fatal('way-too-long-name-way-too-long-name-x:cpu=1', 'invalid profile name');
		fatal(':cpu=1', 'empty name');
		fatal('small:cpu=1,,large:cpu=2', 'position 2 has an empty name');
		fatal(',small:cpu=1', 'position 1 has an empty name');
		fatal('small:cpu=1,', 'position 2 has an empty name');
	});

	it('rejects missing keys or values', () => {
		fatal('small:cpu', 'expected key=value');
		fatal('small:cpu=', 'empty value');
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
});
