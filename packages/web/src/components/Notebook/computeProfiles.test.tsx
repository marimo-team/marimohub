import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
	compareComputeResources,
	computeProfileLabel,
	computeProfileOptions,
	computeProfilePickerValue,
	computeProfileResources,
	computeSessionPresentation,
	DEFAULT_COMPUTE_PROFILE,
	effectiveComputeProfile,
	hasSeparateAppProfiles,
	modeComputeProfile,
	modeComputeProfiles,
} from './computeProfiles';
import { ComputeProfileIndicator } from './ComputeProfileIndicator';

const profiles = [
	{ name: 'small', cpu: 1, memory_bytes: 2 * 1024 ** 3 },
	{ name: 'large', cpu: 8, memory_bytes: 32 * 1024 ** 3 },
];

describe('compute profile presentation', () => {
	it('formats resources and the concrete default label', () => {
		expect(computeProfileResources(profiles[0])).toBe('1 CPU · 2 Gi');
		expect(computeProfileResources({ cpu: 8, memory_bytes: 32 * 1024 ** 3, gpu: 'A100:2' })).toBe(
			'8 CPU · 32 Gi · A100:2 GPU',
		);
		expect(computeProfileResources({})).toBe('platform default');
		expect(computeProfileLabel(profiles[0], true)).toBe('Default (small) — 1 CPU · 2 Gi');
	});

	it('resolves stored, managed, and removed choices', () => {
		expect(effectiveComputeProfile(profiles, 'large', true)?.name).toBe('large');
		expect(effectiveComputeProfile(profiles, 'large', false)?.name).toBe('small');
		expect(effectiveComputeProfile(profiles, 'removed', true)?.name).toBe('small');
	});

	it('keeps unknown resources distinct from equality', () => {
		expect(compareComputeResources({ cpu: 1 }, { cpu: 1 })).toBe('same');
		expect(compareComputeResources({ cpu: 1 }, { cpu: 2 })).toBe('different');
		expect(compareComputeResources({ gpu: 'A100' }, { gpu: 'A100:2' })).toBe('different');
		expect(compareComputeResources({}, { gpu: 'A100' })).toBe('different');
		expect(compareComputeResources(undefined, { cpu: 2 })).toBe('unknown');
	});

	it('builds one canonical picker model, including stale values', () => {
		expect(computeProfilePickerValue(profiles, undefined)).toBe(DEFAULT_COMPUTE_PROFILE);
		expect(computeProfilePickerValue(profiles, 'small')).toBe(DEFAULT_COMPUTE_PROFILE);
		expect(computeProfilePickerValue(profiles, 'large')).toBe('large');
		expect(
			computeProfileOptions(profiles, 'gpu-big').map(({ value, isDisabled }) => ({
				value,
				isDisabled,
			})),
		).toEqual([
			{ value: DEFAULT_COMPUTE_PROFILE, isDisabled: undefined },
			{ value: 'large', isDisabled: undefined },
			{ value: 'gpu-big', isDisabled: true },
		]);
	});

	it('offers the first profile explicitly only when asked, under a custom default label', () => {
		expect(
			computeProfileOptions(profiles, undefined, {
				defaultLabel: 'Use editing profile',
				includeFirst: true,
			}).map(({ value, label, description }) => ({ value, label, description })),
		).toEqual([
			{ value: DEFAULT_COMPUTE_PROFILE, label: 'Use editing profile', description: undefined },
			{ value: 'small', label: 'small', description: '1 CPU · 2 Gi' },
			{ value: 'large', label: 'large', description: '8 CPU · 32 Gi' },
		]);
	});

	it('detects a separate app profile list from capabilities', () => {
		const appProfiles = [{ name: 'app-small', cpu: 1 }];
		const shared = { compute_profiles: profiles };
		const separate = { compute_profiles: profiles, app_compute_profiles: appProfiles };
		expect(hasSeparateAppProfiles(undefined)).toBe(false);
		expect(hasSeparateAppProfiles(shared)).toBe(false);
		expect(hasSeparateAppProfiles({ ...shared, app_compute_profiles: [] })).toBe(false);
		expect(hasSeparateAppProfiles(separate)).toBe(true);
		expect(modeComputeProfiles(shared, 'app')).toBe(profiles);
		expect(modeComputeProfiles({ ...shared, app_compute_profiles: [] }, 'app')).toBe(profiles);
		expect(modeComputeProfiles(separate, 'app')).toBe(appProfiles);
		expect(modeComputeProfiles(separate, 'edit')).toBe(profiles);
		expect(modeComputeProfiles(undefined, 'edit')).toEqual([]);
	});

	it('inherits the editing choice for apps only with a shared list', () => {
		const meta = { compute_profile: 'large' };
		expect(modeComputeProfile(meta, 'app', false)).toBe('large');
		expect(modeComputeProfile(meta, 'app', true)).toBeUndefined();
		expect(modeComputeProfile({ ...meta, app_compute_profile: 'small' }, 'app', false)).toBe(
			'small',
		);
		expect(modeComputeProfile({ ...meta, app_compute_profile: 'small' }, 'edit')).toBe('large');
	});

	it('shows a removed stored profile falling back to Default', () => {
		render(<ComputeProfileIndicator profiles={profiles} storedName="gpu-big" allowOverride />);

		expect(
			screen.getByText('gpu-big (unavailable) → using Default (small) — 1 CPU · 2 Gi'),
		).toBeInTheDocument();
		expect(screen.getByTitle('This profile was removed by your operator.')).toBeInTheDocument();
	});

	it('labels the effective profile as Default when overrides are managed', () => {
		render(
			<ComputeProfileIndicator profiles={profiles} storedName="large" allowOverride={false} />,
		);

		expect(screen.getByText('Default (small) — 1 CPU · 2 Gi')).toBeInTheDocument();
	});

	it('identifies an unchanged snapshot-backed session', () => {
		const presentation = computeSessionPresentation(
			{
				compute_profile: 'small',
				compute_resources: { cpu: 1, memory_bytes: 2 * 1024 ** 3 },
				compute_from_snapshot: true,
			},
			profiles,
			profiles[0],
		);
		expect(presentation.pending).toBe(false);
		expect(presentation.snapshotMessage).toBe('running from snapshot');
	});

	it('identifies snapshot-backed compute after profiles are removed', () => {
		const presentation = computeSessionPresentation({ compute_from_snapshot: true }, [], undefined);
		expect(presentation.snapshotMessage).toBe('running from snapshot');
	});

	it.each([
		{
			name: 'no drift',
			session: {
				compute_profile: 'small',
				compute_resources: { cpu: 1, memory_bytes: 2 * 1024 ** 3 },
			},
			selected: profiles[0],
			reason: undefined,
		},
		{
			name: 'profile changed',
			session: { compute_profile: 'small', compute_resources: { cpu: 1 } },
			selected: profiles[1],
			reason: 'profile',
		},
		{
			name: 'values changed under the same name',
			session: { compute_profile: 'small', compute_resources: { cpu: 0.5 } },
			selected: profiles[0],
			reason: 'resources',
		},
		{
			name: 'same values under a different name',
			session: {
				compute_profile: 'renamed-small',
				compute_resources: { cpu: 1, memory_bytes: 2 * 1024 ** 3 },
			},
			selected: profiles[0],
			reason: 'profile',
		},
		{
			name: 'legacy session without provenance',
			session: {},
			selected: profiles[0],
			reason: 'unknown',
		},
		{
			name: 'legacy snapshot without provenance',
			session: { compute_from_snapshot: true },
			selected: profiles[0],
			reason: 'snapshot',
		},
	] as const)('derives $name', ({ session, selected, reason }) => {
		const presentation = computeSessionPresentation(session, profiles, selected);
		expect(presentation.pendingReason).toBe(reason);
		expect(presentation.pending).toBe(reason !== undefined);
	});
});
