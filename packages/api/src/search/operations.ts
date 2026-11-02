import { NotFoundError, ValidationError } from '@marimo-hub/core';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import { SearchRequestSchema } from '@marimo-hub/core/search';
import type { ApiDeps } from '../context';

export async function searchWorkspace(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	input: unknown,
	signal?: AbortSignal,
) {
	const parsed = SearchRequestSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError('Invalid search request');
	if (!deps.search) throw new NotFoundError('Search is not enabled');
	return deps.search.service.search(principal, parsed.data, signal);
}
