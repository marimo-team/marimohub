import { createElement } from 'react';
import type { ReactElement } from 'react';
import type { RenderOptions } from '@testing-library/react';
import { vi } from 'vitest';
import type { ThemeConfig } from '@marimo-hub/core/theme';
import type { QueryClient } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { ThemeProvider } from '@/context/ThemeContext';
import type { Capabilities, User } from '@/types';
import { installMatchMedia, jsonOk, renderWithClient } from './render';

type Nested<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : Partial<T[K]> };
export type CapabilityOverrides = Nested<Capabilities>;

const BASE_CAPABILITIES: Capabilities = {
	support: { reports: false },
	project_notebook_target: 'notebook',
	workspace_limits: {
		single_put_max_bytes: 0,
		max_file_bytes: 0,
		max_total_bytes: 0,
		max_files: 0,
	},
	project_groups: { available: false },
	federation: { available: false, default_enabled: false },
	integrations: { available: false },
	source_control: {
		preview_providers: [],
		change_request_providers: [],
		sync_providers: [],
		pull_source_providers: [],
	},
	project_alerts: {
		available: false,
		destination_types: [],
		selectable_kinds: [],
		max_destinations: 5,
	},
	jobs: {
		available: false,
		max_per_notebook: null,
		max_queued_runs_per_job: null,
		default_timeout_seconds: null,
		max_timeout_seconds: null,
		run_retention_days: null,
	},
	mcp: { available: false, manual_tokens: false, url: null },
	search: { available: false, semantic: false, kinds: [] },
	chat: { available: false },
	data_browser: { available: false, preview: false, query: false, ai_query: false },
	viewer_mode: 'static',
	viewer_session_modes: [],
	editor_sandbox_sharing: 'shared',
	default_role: null,
	limits: {
		max_concurrent_sessions_per_user: null,
		max_apps_per_project: null,
		max_request_bytes: 0,
		max_versions_per_notebook: 0,
		default_page_size: 50,
		max_page_size: 100,
	},
	sandbox_images: [],
	sandbox_startup_timeout_seconds: 0,
	compute_profiles: [],
	compute_profile_override: 'none',
	surfaces: [],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const defined = (record: Record<string, unknown>) =>
	Object.entries(record).filter(([, value]) => value !== undefined);

/** Every feature off; nested objects in `overrides` merge one level deep; `undefined` keeps the default. */
export function makeCapabilities(overrides: CapabilityOverrides = {}): Capabilities {
	const merged: Record<string, unknown> = structuredClone(BASE_CAPABILITIES);
	for (const [key, value] of defined(overrides)) {
		const base = merged[key];
		merged[key] =
			isRecord(base) && isRecord(value)
				? { ...base, ...Object.fromEntries(defined(value)) }
				: value;
	}
	return merged as Capabilities;
}

export function makeUser(overrides: Partial<User> = {}): User {
	return {
		id: 'u',
		email: 'user@example.com',
		logout_url: null,
		is_super_admin: false,
		can_create_projects: false,
		app_only: false,
		groups: [],
		...overrides,
	};
}

export interface StubRequest {
	url: URL;
	method: string;
	body: unknown;
}

/** A Response is returned as-is; any other value is wrapped in the success envelope. */
type RouteResult = Response | object | string | number | boolean | null;
export type RouteHandler =
	| RouteResult
	| ((request: StubRequest) => RouteResult | Promise<RouteResult>);

export interface StubApiOptions {
	me?: Partial<User>;
	capabilities?: CapabilityOverrides;
}

/**
 * Stubs `fetch` with a router over pathname prefixes (`/api/v1/projects/`), optionally
 * method-scoped (`PATCH /api/v1/projects/p`). The longest matching prefix wins, so
 * `/api/v1/projects` (exact list) and `/api/v1/projects/` (any detail) can coexist.
 * `/api/v1/me` and `/api/v1/capabilities` default to `makeUser`/`makeCapabilities`.
 */
export function stubApi(routes: Record<string, RouteHandler> = {}, options: StubApiOptions = {}) {
	const table: Record<string, RouteHandler> = {
		'/api/v1/me': makeUser(options.me),
		'/api/v1/capabilities': makeCapabilities(options.capabilities),
		...routes,
	};
	const entries = Object.entries(table).map(([key, handler]) => {
		const [method, prefix] = key.includes(' ') ? key.split(' ', 2) : [undefined, key];
		return { method, prefix, handler };
	});
	const requests: string[] = [];
	const calls: StubRequest[] = [];
	const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : input, 'http://localhost');
		const method = init?.method ?? 'GET';
		const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
		const request = { url, method, body };
		requests.push(url.pathname + url.search);
		calls.push(request);
		const route = entries
			.filter(
				(entry) =>
					(!entry.method || entry.method === method) &&
					(url.pathname === entry.prefix ||
						(entry.prefix.endsWith('/') && url.pathname.startsWith(entry.prefix))),
			)
			.sort(
				(a, b) => b.prefix.length - a.prefix.length || Number(!a.method) - Number(!b.method),
			)[0];
		if (!route) throw new Error(`Unexpected request: ${method} ${url.pathname}${url.search}`);
		const result =
			typeof route.handler === 'function'
				? await (route.handler as (request: StubRequest) => Promise<RouteResult>)(request)
				: route.handler;
		return result instanceof Response ? result.clone() : jsonOk(result);
	});
	vi.stubGlobal('fetch', fetch);
	return { fetch, requests, calls };
}

export interface RenderWorkspaceOptions extends Omit<RenderOptions, 'wrapper'> {
	route?: string | string[];
	client?: QueryClient;
	mobile?: boolean;
	branding?: Partial<ThemeConfig>;
	errorBoundary?: boolean;
	toaster?: boolean;
}

export function renderWorkspace(
	ui: ReactElement,
	{ mobile = false, toaster = false, ...options }: RenderWorkspaceOptions = {},
) {
	installMatchMedia(mobile);
	return renderWithClient(
		createElement(ThemeProvider, null, createElement(AuthProvider, null, ui)),
		{
			toaster,
			...options,
		},
	);
}
