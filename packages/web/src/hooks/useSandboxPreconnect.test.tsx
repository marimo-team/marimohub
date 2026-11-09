import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSandboxPreconnect } from './useSandboxPreconnect';

describe('sandbox preconnect', () => {
	it('shares one hint per origin and removes it after the last session ends', () => {
		const first = renderHook(({ url }) => useSandboxPreconnect(url), {
			initialProps: {
				url: 'https://sandbox.example/one?access_token=secret' as string | undefined,
			},
		});
		const second = renderHook(() => useSandboxPreconnect('https://sandbox.example/two'));
		const links = () => document.head.querySelectorAll('link[rel="preconnect"]');
		expect(links()).toHaveLength(1);
		expect(links()[0]).toHaveAttribute('href', 'https://sandbox.example');
		first.rerender({ url: undefined });
		expect(links()).toHaveLength(1);
		second.unmount();
		expect(links()).toHaveLength(0);
	});

	it('does not preconnect to the hub proxy origin', () => {
		renderHook(() => useSandboxPreconnect('/proxy/session'));
		expect(document.head.querySelector('link[rel="preconnect"]')).toBeNull();
	});
});

it('replaces the hint when a sandbox moves to a different origin under StrictMode', () => {
	const { rerender, unmount } = renderHook(({ url }) => useSandboxPreconnect(url), {
		initialProps: { url: 'https://first.example/?access_token=secret' },
		reactStrictMode: true,
	});
	expect(document.head.querySelectorAll('link[rel="preconnect"]')).toHaveLength(1);
	rerender({ url: 'https://second.example/?access_token=other-secret' });
	const links = document.head.querySelectorAll('link[rel="preconnect"]');
	expect(links).toHaveLength(1);
	expect(links[0]).toHaveAttribute('href', 'https://second.example');
	rerender({ url: '/proxy/session' });
	expect(document.head.querySelector('link[rel="preconnect"]')).toBeNull();
	unmount();
});
