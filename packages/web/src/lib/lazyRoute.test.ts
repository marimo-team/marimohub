import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, Suspense } from 'react';
import { render, screen } from '@testing-library/react';
import { lazyRoute, loadRoute } from './lazyRoute';

afterEach(() => {
	sessionStorage.clear();
	vi.restoreAllMocks();
});

describe('route chunk recovery', () => {
	it.each([
		'Failed to fetch dynamically imported module: https://hub.test/missing.js',
		'Importing a module script failed.',
		'error loading dynamically imported module: https://hub.test/missing.js',
		'Unable to preload CSS for /assets/page.css',
	])('reloads once across attempts for %s', async (message) => {
		const error = new TypeError(message);
		const load = vi.fn().mockRejectedValue(error);
		const reload = vi.fn();
		await expect(loadRoute(load, reload)).rejects.toBe(error);
		await expect(loadRoute(load, reload)).rejects.toBe(error);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it('does not reload for application errors', async () => {
		const error = new Error('Component initialization failed');
		const reload = vi.fn();
		await expect(loadRoute(() => Promise.reject(error), reload)).rejects.toBe(error);
		expect(reload).not.toHaveBeenCalled();
	});

	it('does not reset the reload guard when another chunk succeeds', async () => {
		const error = new TypeError('Failed to fetch dynamically imported module');
		const reload = vi.fn();
		await expect(loadRoute(() => Promise.reject(error), reload)).rejects.toBe(error);
		await expect(loadRoute(() => Promise.resolve('ready'), reload)).resolves.toBe('ready');
		await expect(loadRoute(() => Promise.reject(error), reload)).rejects.toBe(error);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it('avoids a reload loop when storage is unavailable', async () => {
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('Blocked storage');
		});
		const error = new TypeError('Failed to fetch dynamically imported module');
		const reload = vi.fn();
		await expect(loadRoute(() => Promise.reject(error), reload)).rejects.toBe(error);
		expect(reload).not.toHaveBeenCalled();
	});
});

describe('route chunk preload', () => {
	it('shares one import between the preload and the render', async () => {
		const load = vi.fn(async () => ({ default: () => createElement('p', null, 'Route ready') }));
		const Route = lazyRoute(load);
		Route.preload();
		Route.preload();
		render(createElement(Suspense, { fallback: null }, createElement(Route)));
		expect(await screen.findByText('Route ready')).toBeVisible();
		expect(load).toHaveBeenCalledTimes(1);
	});

	it('retries the import on render after a failed preload', async () => {
		const load = vi
			.fn()
			.mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module'))
			.mockResolvedValue({ default: () => createElement('p', null, 'Route ready') });
		const Route = lazyRoute(load);
		Route.preload();
		await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
		await Promise.resolve();
		render(createElement(Suspense, { fallback: null }, createElement(Route)));
		expect(await screen.findByText('Route ready')).toBeVisible();
		expect(load).toHaveBeenCalledTimes(2);
		expect(sessionStorage.getItem('marimohub:chunk-reload')).toBeNull();
	});

	it('leaves chunk recovery of a failed preload to the render', async () => {
		const load = vi
			.fn()
			.mockRejectedValue(new TypeError('Failed to fetch dynamically imported module'));
		lazyRoute(load).preload();
		await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
		await Promise.resolve();
		expect(sessionStorage.getItem('marimohub:chunk-reload')).toBeNull();
	});
});
