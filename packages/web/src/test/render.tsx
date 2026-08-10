import type { ReactElement, ReactNode } from 'react';
import { Suspense } from 'react';
import { render, renderHook } from '@testing-library/react';
import type { RenderHookOptions, RenderOptions } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import { vi } from 'vitest';
import { ErrorBoundary } from '@/components/ui';
import { createQueryClient } from '@/api/queryClient';

export function createTestQueryClient(): QueryClient {
	const client = createQueryClient();
	// Merge, don't replace: tests must keep every production default (staleTime,
	// future additions) and override only retry.
	const defaults = client.getDefaultOptions();
	client.setDefaultOptions({
		...defaults,
		queries: { ...defaults.queries, retry: false },
		mutations: { ...defaults.mutations, retry: false },
	});
	return client;
}

interface ProviderOptions {
	client?: QueryClient;
	route?: string | string[];
	toaster?: boolean;
	suspenseFallback?: ReactNode;
	errorBoundary?: boolean;
}

function createWrapper({
	client = createTestQueryClient(),
	route,
	toaster = true,
	suspenseFallback = null,
	errorBoundary = false,
}: ProviderOptions) {
	return function TestWrapper({ children }: { children: ReactNode }) {
		const content = errorBoundary ? (
			<ErrorBoundary fallback={<div>Request failed</div>}>{children}</ErrorBoundary>
		) : (
			children
		);
		let tree = (
			<QueryClientProvider client={client}>
				<Suspense fallback={suspenseFallback}>{content}</Suspense>
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
		errorBoundary,
		...renderOptions
	} = options;
	return {
		client,
		...render(ui, {
			...renderOptions,
			wrapper: createWrapper({ client, route, toaster, suspenseFallback, errorBoundary }),
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
		errorBoundary,
		...hookOptions
	} = options;
	return {
		client,
		...renderHook(callback, {
			...hookOptions,
			wrapper: createWrapper({ client, route, toaster, suspenseFallback, errorBoundary }),
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
