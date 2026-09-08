import { describe, expect, it } from 'vitest';
import type { NotebookId, ProjectId, SandboxId, SessionId } from '../../ids';
import { TEST_KERNEL_AUTH_TOKEN } from '../../testing';
import { signProxyToken } from './proxyToken';
import { kernelBasePathFromUrl, ProxyExposure, SubdomainExposure } from './sandboxExposure';

const SECRET = 'a-test-signing-secret-at-least-32-bytes-long!!';
const ctx = {
	sessionId: 'sess-01HZ0000000000000000000000' as SessionId,
	projectId: 'proj-1' as ProjectId,
	notebookId: 'nb-1' as NotebookId,
	sandboxId: 'sbx-1' as SandboxId,
	kernelAuthToken: TEST_KERNEL_AUTH_TOKEN,
	appBaseUrl: 'https://hub.example.com',
};

describe('SubdomainExposure', () => {
	const exposure = new SubdomainExposure();

	it('serves at root (no marimo base url)', async () => {
		expect(await exposure.prepare(ctx)).toEqual({});
	});

	it('adds the kernel token to the adapter URL and records no origin', async () => {
		const result = await exposure.finalize('https://sbx-1.sandbox.example.net', ctx);
		expect(result).toEqual({
			clientUrl: `https://sbx-1.sandbox.example.net/?access_token=${TEST_KERNEL_AUTH_TOKEN}`,
		});
		expect(result.originUrl).toBeUndefined();
	});

	it('preserves provider query parameters and fragments', async () => {
		const result = await exposure.finalize(
			'https://sandbox.example.net/open?provider=one&provider=two&empty=#notebook',
			ctx,
		);
		expect(result.clientUrl).toBe(
			`https://sandbox.example.net/open?provider=one&provider=two&empty=&access_token=${TEST_KERNEL_AUTH_TOKEN}#notebook`,
		);
	});

	it.each([
		'https://sandbox.example.net/?access_token=provider-credential',
		'https://sandbox.example.net/?access_token=',
		'https://sandbox.example.net/?%61ccess_token=provider-credential',
	])('rejects an adapter URL containing the reserved token parameter: %s', async (url) => {
		await expect(exposure.finalize(url, ctx)).rejects.toThrow(
			'Sandbox exposure URL contains reserved access_token query parameter',
		);
	});
});

describe('ProxyExposure', () => {
	const exposure = new ProxyExposure(SECRET);

	it('launches marimo under /proxy/<token> and matches the client path', async () => {
		const { baseUrl } = await exposure.prepare(ctx);
		const token = await signProxyToken(ctx.projectId, ctx.sessionId, SECRET);
		expect(baseUrl).toBe(`/proxy/${token}`);

		const result = await exposure.finalize('http://kernel.internal:2718', ctx);
		expect(result.clientUrl).toBe(`https://hub.example.com/proxy/${token}/`);
		// The adapter URL becomes the server-reachable origin the forwarder targets.
		expect(result.originUrl).toBe('http://kernel.internal:2718');
	});

	it('trims a trailing slash on the app base url', async () => {
		const result = await exposure.finalize('http://kernel:2718', {
			...ctx,
			appBaseUrl: 'https://hub.example.com/',
		});
		const token = await signProxyToken(ctx.projectId, ctx.sessionId, SECRET);
		expect(result.clientUrl).toBe(`https://hub.example.com/proxy/${token}/`);
	});

	it('collapses multiple trailing slashes on the app base url (no `//proxy`)', async () => {
		const result = await exposure.finalize('http://kernel:2718', {
			...ctx,
			appBaseUrl: 'https://hub.example.com//',
		});
		const token = await signProxyToken(ctx.projectId, ctx.sessionId, SECRET);
		expect(result.clientUrl).toBe(`https://hub.example.com/proxy/${token}/`);
	});

	it.each(['https://hub.example.com/marimohub', 'https://hub.example.com/marimohub/'])(
		'preserves a path prefix in marimo and client URLs: %s',
		async (appBaseUrl) => {
			const prefixedCtx = { ...ctx, appBaseUrl };
			const token = await signProxyToken(ctx.projectId, ctx.sessionId, SECRET);

			expect(await exposure.prepare(prefixedCtx)).toEqual({
				baseUrl: `/marimohub/proxy/${token}`,
			});
			const result = await exposure.finalize('http://kernel:2718', prefixedCtx);
			expect(result.clientUrl).toBe(`https://hub.example.com/marimohub/proxy/${token}/`);
		},
	);
});

describe('kernelBasePathFromUrl', () => {
	it.each([
		[undefined, ''],
		['not a url', ''],
		['https://kernel.example/', ''],
		['https://hub.example/proxy/token///?access_token=secret', '/proxy/token'],
	])('extracts the marimo base path from %s', (url, expected) => {
		expect(kernelBasePathFromUrl(url)).toBe(expected);
	});
});
