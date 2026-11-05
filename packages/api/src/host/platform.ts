import {
	bearerToken,
	DomainError,
	HostNotebookId,
	NotFoundError,
	paths,
	ProjectId,
	SessionId,
} from '@marimo-hub/core';
import type { AuthenticatedPrincipal, NotebookDetail, Project, Session } from '@marimo-hub/core';
import { HostProblemError } from '@marimo-hub/host-protocol';
import type {
	HostNotebookContext,
	HostPlatform,
	HostRequestContext,
	HostRuntimeDiscovery,
	HostRuntimeHandle,
} from '@marimo-hub/host-protocol';
import type { ApiDeps } from '../context';
import { refreshIdentityFor } from '../identity';
import { authorizeMcpSession, sessionAuthorizationDeadline } from '../mcp/sessionActivity';
import {
	assertProjectActionOn,
	authMethodFor,
	initializeForSubject,
	loadVisibleProject,
	parseIfMatch,
	resolvePublicBaseUrlFor,
} from '../shared';
import { catalogEvents, hostNotebookSubject, loadHostNotebook, notebookRecord } from './catalog';
import type { HostCatalog } from './catalog';
import { callRuntime, DECISION_PREFIX, ensureHostSession, existingHostSession } from './runtime';
import type { HostSessionRequest } from './runtime';

export interface HubHostNotebook extends HostNotebookContext {
	project: Project;
	notebook: NotebookDetail;
	/** The principal's own temporary editor session, when the ID names a temporary notebook. */
	session?: Session;
}

export interface HubHostRuntime extends HostRuntimeHandle {
	project: Project;
	notebook: NotebookDetail;
	session: Session;
}

export type HubHostPlatform = HostPlatform<
	AuthenticatedPrincipal,
	HubHostNotebook,
	HubHostRuntime,
	HostCatalog
>;

const EMPTY_NOTEBOOK =
	'import marimo\n\napp = marimo.App()\n\nif __name__ == "__main__":\n    app.run()\n';

export function hubErrorStatus(error: unknown): number | undefined {
	return error instanceof DomainError ? error.status : undefined;
}

function runtimeHandle(
	project: Project,
	notebook: NotebookDetail,
	session: Session,
): HubHostRuntime {
	return {
		notebookId: HostNotebookId.create(
			project.id,
			notebook.meta.id,
			session.ephemeral ? session.session_id : undefined,
		),
		projectId: project.id,
		key: session.session_id,
		project,
		notebook,
		session,
	};
}

function sessionRequest(deps: ApiDeps, context: HostRequestContext): HostSessionRequest {
	const url = new URL(context.request.url);
	return {
		requestId: context.requestId,
		method: context.request.method,
		path: url.pathname,
		hostname: url.hostname,
		appBaseUrl: resolvePublicBaseUrlFor(context.request, deps.sandbox.appBaseUrl),
		signal: context.signal,
	};
}

export function createHubHostPlatform(deps: ApiDeps): HubHostPlatform {
	async function resolveNotebook(
		principal: AuthenticatedPrincipal,
		id: string,
	): Promise<HubHostNotebook> {
		const { project, notebook, session } = await loadHostNotebook(deps, principal, id);
		const record = await notebookRecord(
			deps,
			principal,
			project,
			hostNotebookSubject(notebook),
			session,
		);
		return { project, notebook, session, record };
	}

	return {
		decisionPrefix: DECISION_PREFIX,
		// Spec generation builds the API without services; the store is only needed per mutation.
		get retries() {
			return deps.services.hostRetries;
		},
		errorStatus: hubErrorStatus,

		async authenticate(request) {
			const user = bearerToken(request) ? await deps.authenticator.authenticate(request) : null;
			if (!user || authMethodFor(user.credential.kind) !== 'pat')
				throw HostProblemError.unauthorized('A hub bearer token is required');
			if (await deps.services.identities.isSuspended(user.id))
				throw HostProblemError.forbidden('User account is suspended');
			const deadlines = [user.credential.expiresAt, user.entitlementsExpiresAt].filter(
				(value) => value !== undefined,
			);
			if (
				deadlines.some(
					(value) => !Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now(),
				)
			)
				throw HostProblemError.unauthorized('Bearer authorization has expired');
			return user;
		},

		async onAuthenticated(user, context) {
			await refreshIdentityFor(deps, user, {
				requestId: context.requestId,
				method: context.request.method,
				path: new URL(context.request.url).pathname,
			});
			if (user.credential.kind !== 'service-account') await initializeForSubject(deps, user);
		},

		catalog: (principal) => catalogEvents(deps, principal),
		catalogVersion: async () => (await deps.bucket.head(paths.catalog))?.etag ?? null,

		async runtimes(principal, snapshot, visible, signal) {
			const discovered: HostRuntimeDiscovery<HubHostRuntime>[] = [];
			for (const [pid, sessions] of snapshot.sessions) {
				for (const session of sessions) {
					if (session.status !== 'running') continue;
					const notebookId = HostNotebookId.create(
						pid,
						session.notebook_id,
						session.ephemeral ? session.session_id : undefined,
					);
					const entry: HostRuntimeDiscovery<HubHostRuntime> = {
						notebookId,
						projectId: pid,
						key: session.session_id,
						authorized: false,
					};
					if (visible.has(notebookId)) {
						try {
							const decision = await authorizeMcpSession(deps, principal, session);
							sessionAuthorizationDeadline(session, principal, decision.subjectContextExpiresAt);
							entry.authorized = true;
						} catch {
							signal.throwIfAborted();
						}
					}
					if (entry.authorized && session.mode !== 'app' && deps.compute.connectExisting)
						entry.connect = async () => {
							const { project, notebook } = await loadHostNotebook(deps, principal, notebookId);
							return runtimeHandle(project, notebook, session);
						};
					discovered.push(entry);
				}
			}
			return discovered;
		},

		resolveNotebook,

		async createNotebook(principal, input) {
			if (input.path !== undefined)
				throw HostProblemError.invalidRequest('Hub projects have no root; omit path and set name');
			if (!ProjectId.is(input.project_id)) throw HostProblemError.notFound('Project not found');
			const project = await loadVisibleProject(
				deps.services.projects,
				ProjectId.parse(input.project_id),
				principal,
				deps,
			);
			await assertProjectActionOn(project, principal, 'notebook.write', deps);
			return {
				async commit(attempt) {
					await attempt.dispatch();
					const created = await deps.services.notebooks.createNotebook(
						project.id,
						{ title: input.name, description: '', code: EMPTY_NOTEBOOK },
						principal.id,
					);
					return notebookRecord(
						deps,
						principal,
						project,
						hostNotebookSubject(await deps.services.notebooks.getNotebook(project.id, created.id)),
					);
				},
			};
		},

		async updateNotebook(principal, { project, notebook, session }, input, ifMatch) {
			if (input.path !== undefined)
				throw HostProblemError.unsupportedOperation('Hub notebooks have no path; rename with name');
			const name = input.name;
			if (name === undefined) throw HostProblemError.invalidRequest('name is required');
			if (session) throw HostProblemError.forbidden('Temporary notebooks cannot be renamed');
			await assertProjectActionOn(
				project,
				principal,
				'notebook.write',
				deps,
				notebook.meta.security_labels ?? null,
			);
			return {
				async commit(attempt) {
					await attempt.dispatch();
					const updated = await deps.services.notebooks.updateNotebook(
						project.id,
						notebook.meta.id,
						{ title: name },
						principal.id,
						parseIfMatch(ifMatch),
					);
					return notebookRecord(deps, principal, project, {
						...hostNotebookSubject(notebook),
						title: updated.title,
						updated_at: updated.updated_at,
						labels: updated.security_labels ?? null,
					});
				},
			};
		},

		async ensureRuntime(principal, { project, notebook, session }, options, context) {
			const started = await ensureHostSession(
				deps,
				principal,
				sessionRequest(deps, context),
				project,
				notebook,
				{ session, decisions: options.decisions, key: options.key },
			);
			return runtimeHandle(project, notebook, started);
		},

		async existingRuntime(principal, { project, notebook, session }) {
			return runtimeHandle(
				project,
				notebook,
				await existingHostSession(deps, principal, project, notebook, session),
			);
		},

		async runtimeByKey(_principal, { project, notebook }, key) {
			const gone = () => HostProblemError.noRuntime('The original runtime is no longer available');
			if (!SessionId.is(key)) throw gone();
			let session: Session;
			try {
				session = await deps.services.sessions.getSession(project.id, key);
			} catch (error) {
				if (error instanceof NotFoundError) throw gone();
				throw error;
			}
			if (session.status !== 'running') throw gone();
			return runtimeHandle(project, notebook, session);
		},

		callRuntime(principal, runtime, request, signal, { keepAlive }) {
			return callRuntime(
				deps,
				principal,
				runtime.project,
				runtime.notebook,
				runtime.session,
				request,
				signal,
				keepAlive,
			);
		},
	};
}
