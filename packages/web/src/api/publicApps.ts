import { useQuery } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { withBasePath } from '@/lib/basePath';

export const PUBLIC_VISIT_TOKEN_HEADER = 'X-MH-Visit-Token';

export interface PublicAppInfo {
	slug: string;
	title: string;
	heartbeat_interval_seconds: number;
	startup_timeout_seconds: number;
}

export interface PublicAppVisit {
	slug: string;
	status: 'starting' | 'running' | 'ended';
	sandbox_url: string | null;
	visit_token: string;
	heartbeat_interval_seconds: number;
	startup_timeout_seconds: number;
}

export class PublicAppApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string,
	) {
		super(message);
		this.name = 'PublicAppApiError';
	}
}

export function isPublicAppNotFound(error: unknown): boolean {
	return error instanceof PublicAppApiError && error.status === 404;
}

function encodeSlugPath(slug: string): string {
	return slug
		.split('/')
		.map((segment) => encodeURIComponent(segment))
		.join('/');
}

async function parsePublicResponse<T>(response: Response): Promise<T> {
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = null;
	}
	if (
		response.ok &&
		body &&
		typeof body === 'object' &&
		'success' in body &&
		body.success === true &&
		'data' in body
	) {
		return (body as { data: T }).data;
	}
	const err =
		body && typeof body === 'object' && 'error' in body
			? (body as { error?: { code?: string; message?: string } }).error
			: undefined;
	throw new PublicAppApiError(
		err?.message ?? 'Unable to open this app right now.',
		response.status,
		err?.code ?? 'UNKNOWN',
	);
}

export const publicAppKeys = {
	resolve: (slug: string) => ['public-apps', 'resolve', slug] as const,
};

export async function resolvePublicApp(slug: string, signal?: AbortSignal): Promise<PublicAppInfo> {
	const url = withBasePath(`/api/public/v1/apps/${encodeSlugPath(slug)}`);
	const response = await fetch(url, {
		method: 'GET',
		credentials: 'omit',
		headers: { Accept: 'application/json' },
		signal,
	});
	return parsePublicResponse<PublicAppInfo>(response);
}

const bootPublicLookups = new WeakMap<QueryClient, Map<string, Promise<PublicAppInfo>>>();

export function prefetchPublicApp(client: QueryClient, slug: string) {
	if (!slug) return;
	const lookups = bootPublicLookups.get(client) ?? new Map<string, Promise<PublicAppInfo>>();
	bootPublicLookups.set(client, lookups);
	if (!lookups.has(slug)) {
		const pending = resolvePublicApp(slug);
		lookups.set(slug, pending);
		void pending.catch(() => {});
	}
	return lookups.get(slug)!;
}

export function usePublicAppQuery(slug: string, enabled = true) {
	return useQuery({
		queryKey: publicAppKeys.resolve(slug),
		enabled: enabled && slug.length > 0,
		queryFn: ({ signal }) => resolvePublicApp(slug, signal),
		retry: false,
		staleTime: 0,
		gcTime: 0,
	});
}

export async function startPublicAppVisit(
	slug: string,
	priorToken?: string,
	signal?: AbortSignal,
): Promise<PublicAppVisit> {
	const headers: Record<string, string> = {
		Accept: 'application/json',
		'Content-Type': 'application/json',
	};
	if (priorToken) headers[PUBLIC_VISIT_TOKEN_HEADER] = priorToken;
	const response = await fetch(withBasePath('/api/public/v1/visits'), {
		method: 'POST',
		credentials: 'same-origin',
		headers,
		body: JSON.stringify({ slug }),
		signal,
	});
	return parsePublicResponse<PublicAppVisit>(response);
}

export async function pollPublicAppVisit(
	visitToken: string,
	waitSeconds = 15,
	signal?: AbortSignal,
): Promise<PublicAppVisit> {
	const response = await fetch(
		withBasePath(`/api/public/v1/visits/current?wait=${encodeURIComponent(String(waitSeconds))}`),
		{
			method: 'GET',
			credentials: 'same-origin',
			headers: {
				Accept: 'application/json',
				[PUBLIC_VISIT_TOKEN_HEADER]: visitToken,
			},
			signal,
		},
	);
	return parsePublicResponse<PublicAppVisit>(response);
}

export async function heartbeatPublicAppVisit(
	visitToken: string,
	signal?: AbortSignal,
): Promise<PublicAppVisit> {
	const response = await fetch(withBasePath('/api/public/v1/visits/heartbeat'), {
		method: 'POST',
		credentials: 'same-origin',
		headers: {
			Accept: 'application/json',
			[PUBLIC_VISIT_TOKEN_HEADER]: visitToken,
		},
		signal,
	});
	return parsePublicResponse<PublicAppVisit>(response);
}

export function leavePublicAppVisit(visitToken: string): void {
	void fetch(withBasePath('/api/public/v1/visits/leave'), {
		method: 'POST',
		credentials: 'same-origin',
		keepalive: true,
		headers: {
			Accept: 'application/json',
			[PUBLIC_VISIT_TOKEN_HEADER]: visitToken,
		},
	}).catch(() => {});
}
