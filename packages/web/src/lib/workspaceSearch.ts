import { matchPath } from 'react-router-dom';

export const SEARCH_ROUTE = '/search';
export const PROJECT_SEARCH_ROUTE = '/projects/:pid/search';
export const SEARCH_RESULT_LIMIT = 50;

export function searchPath(projectId?: string) {
	return projectId ? `/projects/${encodeURIComponent(projectId)}/search` : SEARCH_ROUTE;
}

export function isSearchPath(pathname: string) {
	return Boolean(matchPath(SEARCH_ROUTE, pathname) || matchPath(PROJECT_SEARCH_ROUTE, pathname));
}
