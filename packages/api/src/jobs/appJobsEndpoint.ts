import type { ApiDeps } from '../context';

export const APP_JOBS_PATH = '/api/app-jobs/v1';

export function appJobsEndpoint(deps: ApiDeps, request: Request) {
	return `${(deps.sandbox.appBaseUrl ?? new URL(request.url).origin).replace(/\/$/, '')}${APP_JOBS_PATH}`;
}
