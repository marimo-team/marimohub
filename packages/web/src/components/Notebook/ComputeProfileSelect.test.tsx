import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
	ComputeProfileIndicator,
	computeProfileLabel,
	computeProfileResources,
	computeResourcesEqual,
	effectiveComputeProfile,
} from './ComputeProfileSelect';

const profiles = [
	{ name: 'small', cpu: 1, memory_bytes: 2 * 1024 ** 3 },
	{ name: 'large', cpu: 8, memory_bytes: 32 * 1024 ** 3 },
];

describe('compute profile presentation', () => {
	it('formats resources and the concrete default label', () => {
		expect(computeProfileResources(profiles[0])).toBe('1 CPU · 2 Gi');
		expect(computeProfileResources({})).toBe('platform default');
		expect(computeProfileLabel(profiles[0], true)).toBe('Default (small) — 1 CPU · 2 Gi');
	});

	it('resolves stored, managed, and removed choices', () => {
		expect(effectiveComputeProfile(profiles, 'large', true)?.name).toBe('large');
		expect(effectiveComputeProfile(profiles, 'large', false)?.name).toBe('small');
		expect(effectiveComputeProfile(profiles, 'removed', true)?.name).toBe('small');
	});

	it('compares resolved resources when both sides are known', () => {
		expect(computeResourcesEqual({ cpu: 1 }, { cpu: 1 })).toBe(true);
		expect(computeResourcesEqual({ cpu: 1 }, { cpu: 2 })).toBe(false);
		expect(computeResourcesEqual(undefined, { cpu: 2 })).toBe(true);
	});

	it('shows a removed stored profile falling back to Default', () => {
		render(<ComputeProfileIndicator profiles={profiles} storedName="gpu-big" allowOverride />);

		expect(
			screen.getByText('gpu-big (unavailable) → using Default (small) — 1 CPU · 2 Gi'),
		).toBeInTheDocument();
		expect(screen.getByTitle('This profile was removed by your operator.')).toBeInTheDocument();
	});
});
