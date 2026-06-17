import type { ReactElement, ReactNode } from 'react';
import { Suspense } from 'react';
import { render, renderHook } from '@testing-library/react';
import type { RenderHookOptions, RenderOptions } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import { vi } from 'vitest';

export function createTestQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
}

interface ProviderOptions {
	client?: QueryClient;
	route?: string | string[];
	toaster?: boolean;
	suspenseFallback?: ReactNode;
}

function createWrapper({
	client = createTestQueryClient(),
	route,
	toaster = true,
	suspenseFallback = null,
}: ProviderOptions) {
	return function TestWrapper({ children }: { children: ReactNode }) {
		let tree = (
			<QueryClientProvider client={client}>
				<Suspense fallback={suspenseFallback}>{children}</Suspense>
				{toaster && <Toaster />}
			</QueryClientProvider>
		);
		if (route) {
			tree = (
				<MemoryRouter initialEntries={Array.isArray(route) ? route : [route]}>{tree}</MemoryRouter>
			);
		}
		return tree;
	};
}

export function renderWithClient(
	ui: ReactElement,
	options: Omit<RenderOptions, 'wrapper'> & ProviderOptions = {},
) {
	const {
		client = createTestQueryClient(),
		route,
		toaster,
		suspenseFallback,
		...renderOptions
	} = options;
	return {
		client,
		...render(ui, {
			...renderOptions,
			wrapper: createWrapper({ client, route, toaster, suspenseFallback }),
		}),
	};
}

export function renderHookWithClient<Result, Props>(
	callback: (initialProps: Props) => Result,
	options: Omit<RenderHookOptions<Props>, 'wrapper'> & ProviderOptions = {},
) {
	const {
		client = createTestQueryClient(),
		route,
		toaster,
		suspenseFallback,
		...hookOptions
	} = options;
	return {
		client,
		...renderHook(callback, {
			...hookOptions,
			wrapper: createWrapper({ client, route, toaster, suspenseFallback }),
		}),
	};
}

export function installMatchMedia(matches = false): void {
	vi.stubGlobal('matchMedia', (query: string) => ({
		matches,
		media: query,
		onchange: null,
		addEventListener: () => {},
		removeEventListener: () => {},
		addListener: () => {},
		removeListener: () => {},
		dispatchEvent: () => false,
	}));
}

export function jsonOk(data: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set('content-type', headers.get('content-type') ?? 'application/json');
	return new Response(JSON.stringify({ success: true, data }), {
		...init,
		headers,
	});
}

export function jsonError(code: string, message: string, status = 500): Response {
	const headers = new Headers({ 'content-type': 'application/json' });
	return new Response(JSON.stringify({ success: false, error: { code, message } }), {
		status,
		headers,
	});
}
