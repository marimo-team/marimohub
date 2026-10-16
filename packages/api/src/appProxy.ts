import {
	AppPoolService,
	AppVisitSchema,
	joinUrlPath,
	kernelBasePathFromUrl,
	NotebookId,
	ProjectId,
	SessionId,
	isPastAuthorizationDeadline,
	sessionMode,
	sessionResourceNotebookId,
	NotFoundError,
	ProxyExposure,
	UnavailableError,
	signProxyToken,
} from '@marimo-hub/core';
import type { ApiDeps } from './context';
import { SANDBOX_PROXY_PREFIXES } from './proxyRoutes';
import { assertSessionPreviewActive, authorizationService } from './shared';
import type { ProxyDecision } from './sandboxProxy';

export const APP_PROXY_PREFIX = new RegExp(
	`^${SANDBOX_PROXY_PREFIXES.app}/([^/]+)/([^/]+)/([^/]+)(?=/|$)`,
);
export const APP_VISIT_HEADER = 'x-marimohub-app-visit-id';
export const APP_GENERATION_HEADER = 'x-marimohub-app-generation';
export const APP_STATUS_HEADER = 'x-marimohub-app-status';
export const APP_PROXY_HEADER = 'x-marimohub-app-proxy';

function trimTrailingSlash(s: string): string {
	return s.endsWith('/') ? s.slice(0, -1) : s;
}

function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
	return promise.then(
		(value) => ({ status: 'fulfilled', value }),
		(reason: unknown) => ({ status: 'rejected', reason }),
	);
}

function settledValue<T>(result: PromiseSettledResult<T>): T {
	if (result.status === 'rejected') throw result.reason;
	return result.value;
}

export async function authorizeAppProxyRequest(
	request: Request,
	deps: ApiDeps,
): Promise<ProxyDecision> {
	const url = new URL(request.url);
	const appMatch = APP_PROXY_PREFIX.exec(url.pathname);
	if (!appMatch) return { kind: 'pass' };

	const exposure = deps.sandbox.exposure;
	const secret = exposure instanceof ProxyExposure ? exposure.signingSecret : undefined;
	if (!secret) return { kind: 'pass' };

	const visit = AppVisitSchema.safeParse({
		visit_id: request.headers.get(APP_VISIT_HEADER),
		generation: request.headers.get(APP_GENERATION_HEADER),
	});
	if (!visit.success || !NotebookId.is(appMatch[2])) {
		return { kind: 'reject', status: 403, code: 'FORBIDDEN', message: 'Invalid app visit' };
	}
	// The canonical app route is authenticated below and fenced by an exact visit;
	// it cannot fall back to the older proxy contract on a mixed-version rollout.
	if (!ProjectId.is(appMatch[1]) || !SessionId.is(appMatch[3])) {
		return { kind: 'reject', status: 403, code: 'FORBIDDEN', message: 'Invalid app route' };
	}
	const projectId = appMatch[1];
	const notebookId = appMatch[2];
	const sessionId = appMatch[3];

	const user = await deps.authenticator.authenticate(request);
	if (!user) {
		return {
			kind: 'reject',
			status: 401,
			code: 'UNAUTHORIZED',
			message: 'Authentication required',
		};
	}

	// Proxy traffic bypasses the API auth middleware, so both HTTP and WebSocket
	// forwarding enforce suspension here.
	try {
		if (await deps.services.identities.isSuspended(user.id)) {
			return {
				kind: 'reject',
				status: 403,
				code: 'USER_SUSPENDED',
				message: 'User account is suspended',
			};
		}
	} catch (err) {
		if (err instanceof UnavailableError) {
			return {
				kind: 'reject',
				status: 503,
				code: 'SERVICE_UNAVAILABLE',
				message: 'Unable to verify account suspension status',
			};
		}
		throw err;
	}

	// Handle speculative failures immediately; an earlier failure must not wait for later reads.
	const sessionRead = settle(deps.services.sessions.getSession(projectId, sessionId));
	const projectRead = settle(
		deps.services.projects.getProject(projectId, { consistency: 'validated' }),
	);
	const notebookRead = settle(
		deps.services.notebooks.getSecurityLabels(projectId, notebookId, { consistency: 'validated' }),
	);
	let session;
	try {
		session = settledValue(await sessionRead);
	} catch {
		return { kind: 'reject', status: 404, code: 'NOT_FOUND', message: 'Session not found' };
	}
	if (
		sessionMode(session) !== 'app' ||
		!session.app_pool ||
		sessionResourceNotebookId(session) !== notebookId
	) {
		return { kind: 'reject', status: 404, code: 'NOT_FOUND', message: 'Session not found' };
	}

	if (session.status !== 'running' && session.status !== 'starting') {
		return { kind: 'reject', status: 410, code: 'GONE', message: 'Session is no longer running' };
	}
	const authorizationDeadline = session.authorization_expires_at
		? Date.parse(session.authorization_expires_at)
		: undefined;
	if (authorizationDeadline !== undefined && Date.now() >= authorizationDeadline) {
		return {
			kind: 'reject',
			status: 410,
			code: 'GONE',
			message: 'Session authorization has expired',
		};
	}

	const originUrl = session.sandbox_origin_url;
	if (!originUrl && session.status !== 'starting') {
		return {
			kind: 'reject',
			status: 503,
			code: 'SERVICE_UNAVAILABLE',
			message: 'Session is not reachable via the proxy',
		};
	}

	let project;
	try {
		project = settledValue(await projectRead);
	} catch {
		// A session whose project is gone is unreachable, like a missing session.
		return { kind: 'reject', status: 404, code: 'NOT_FOUND', message: 'Session not found' };
	}
	// Missing resources mask; unreadable authorization metadata fails closed.
	const notebookResult = await settle(
		(async () => {
			await assertSessionPreviewActive(deps, projectId, session);
			return settledValue(await notebookRead);
		})(),
	);
	if (notebookResult.status === 'rejected') {
		if (notebookResult.reason instanceof NotFoundError) {
			return { kind: 'reject', status: 404, code: 'NOT_FOUND', message: 'Session not found' };
		}
		return {
			kind: 'reject',
			status: 503,
			code: 'SERVICE_UNAVAILABLE',
			message: 'Session authorization could not be verified',
		};
	}
	const notebookLabels = notebookResult.value;
	const authorizer = authorizationService(deps);
	const resource = { kind: 'session' as const, project, session, notebookLabels };
	const decision = await authorizer.authorize(user, 'session.proxy', resource);
	if (!decision.allowed) {
		if (
			decision.category === 'lifecycle' ||
			decision.category === 'constraint' ||
			decision.category === 'credential-resource'
		) {
			return { kind: 'reject', status: 404, code: 'NOT_FOUND', message: 'Session not found' };
		}
		return {
			kind: 'reject',
			status: 403,
			code: 'FORBIDDEN',
			message: 'Not authorized to attach this session',
		};
	}
	// Renewal needs attach permission as well as proxy permission, including
	// action-specific resource-security policy and scoped credential grants.
	const renewalDecision = await authorizer.authorize(user, 'session.attach', resource);
	if (!renewalDecision.allowed) {
		if (
			renewalDecision.category === 'constraint' ||
			renewalDecision.category === 'lifecycle' ||
			renewalDecision.category === 'credential-resource'
		) {
			return { kind: 'reject', status: 404, code: 'NOT_FOUND', message: 'Session not found' };
		}
		return {
			kind: 'reject',
			status: 403,
			code: 'FORBIDDEN',
			message: 'App renewal not authorized',
		};
	}

	// An established socket must not outlive the session or either policy decision.
	const contextDeadline =
		decision.subjectContextExpiresAt !== undefined
			? Date.parse(decision.subjectContextExpiresAt)
			: undefined;
	let effectiveDeadline =
		authorizationDeadline !== undefined && contextDeadline !== undefined
			? Math.min(authorizationDeadline, contextDeadline)
			: (authorizationDeadline ?? contextDeadline);
	if (renewalDecision.subjectContextExpiresAt) {
		effectiveDeadline = Math.min(
			effectiveDeadline ?? Infinity,
			Date.parse(renewalDecision.subjectContextExpiresAt),
		);
	}
	if (effectiveDeadline !== undefined && Date.now() >= effectiveDeadline) {
		return {
			kind: 'reject',
			status: 410,
			code: 'GONE',
			message: 'Session authorization has expired',
		};
	}

	try {
		const pool = new AppPoolService(
			deps.bucket,
			deps.services.sessions,
			deps.policy.appPool,
			deps.metrics,
		);
		const allowed = await pool.heartbeat(
			projectId,
			session.notebook_id,
			user.id,
			sessionId,
			visit.data,
		);
		if (!allowed) {
			return {
				kind: 'reject',
				status: 410,
				code: 'GONE',
				message: 'The app assignment expired. Open the app again.',
			};
		}
		session = await deps.services.sessions.heartbeatFromSnapshot(session);
		if (
			(session.status !== 'running' && session.status !== 'starting') ||
			isPastAuthorizationDeadline(session, Date.now())
		) {
			return {
				kind: 'reject',
				status: 410,
				code: 'GONE',
				message: 'Session is no longer running',
			};
		}
		if (session.sandbox_origin_url !== originUrl) {
			return {
				kind: 'reject',
				status: 503,
				code: 'SERVICE_UNAVAILABLE',
				message: 'Session target changed',
			};
		}
	} catch {
		return {
			kind: 'reject',
			status: 503,
			code: 'SERVICE_UNAVAILABLE',
			message: 'Session authorization could not be verified',
		};
	}
	if (session.authorization_expires_at) {
		effectiveDeadline = Math.min(
			effectiveDeadline ?? Infinity,
			Date.parse(session.authorization_expires_at),
		);
	}
	if (effectiveDeadline !== undefined && Date.now() >= effectiveDeadline) {
		return {
			kind: 'reject',
			status: 410,
			code: 'GONE',
			message: 'Session authorization has expired',
		};
	}

	if (session.status === 'starting') return { kind: 'starting' };
	if (!originUrl) {
		return {
			kind: 'reject',
			status: 503,
			code: 'SERVICE_UNAVAILABLE',
			message: 'Session is not reachable via the proxy',
		};
	}

	// Keep the base path used when this kernel was provisioned, even if deployment config changes.
	const appKernelBase =
		kernelBasePathFromUrl(session.sandbox_url) ||
		`/proxy/${await signProxyToken(projectId, sessionId, secret)}`;
	const upstreamPath = `${appKernelBase}${url.pathname.slice(appMatch[0].length) || '/'}`;
	const targetUrl = `${trimTrailingSlash(originUrl)}${upstreamPath}${url.search}`;
	return {
		kind: 'forward',
		targetUrl,
		sessionId,
		...(session.kernel_auth_token ? { kernelAuthToken: session.kernel_auth_token } : {}),
		...(effectiveDeadline !== undefined ? { authorizationDeadline: effectiveDeadline } : {}),
		appProxyBaseUrl: `${trimTrailingSlash(originUrl)}${appKernelBase}`,
	};
}

export async function appProxyResponse(
	response: Response,
	requestUrl: string,
	targetUrl: string,
	baseUrl: string,
	publicBaseUrl: string,
): Promise<Response> {
	const location = response.headers.get('location');
	if (location === null) return response;
	const target = new URL(targetUrl);
	const kernelBase = new URL(baseUrl).pathname;
	let redirect: URL | undefined;
	try {
		redirect = new URL(location, target);
	} catch {
		// An invalid Location must not turn a handled upstream response into a 500.
	}
	if (
		!redirect ||
		redirect.origin !== target.origin ||
		(redirect.pathname !== kernelBase && !redirect.pathname.startsWith(`${kernelBase}/`))
	) {
		await response.body?.cancel();
		return Response.json(
			{
				success: false,
				error: { code: 'SERVICE_UNAVAILABLE', message: 'Kernel redirect left the app' },
			},
			{ status: 502 },
		);
	}
	const request = new URL(requestUrl);
	const appBase = APP_PROXY_PREFIX.exec(request.pathname)![0];
	const headers = new Headers(response.headers);
	headers.set(
		'location',
		`${joinUrlPath(publicBaseUrl, `${appBase}${redirect.pathname.slice(kernelBase.length)}`)}${redirect.search}${redirect.hash}`,
	);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
