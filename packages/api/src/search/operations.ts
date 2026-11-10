import {
	NotFoundError,
	ResourceExhaustedError,
	ValidationError,
	createSlidingWindowBudget,
	weakMemo,
} from '@marimo-hub/core';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import { SearchRequestSchema } from '@marimo-hub/core/search';
import type { ApiDeps } from '../context';

export const SEARCH_QUERIES_PER_MINUTE = 30;

// Keyed by the configured search bundle so REST and MCP share one per-user budget.
const budgetFor = weakMemo((_search: NonNullable<ApiDeps['search']>) =>
	createSlidingWindowBudget<string>({ limit: SEARCH_QUERIES_PER_MINUTE, windowMs: 60_000 }),
);

export async function searchWorkspace(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	input: unknown,
	signal?: AbortSignal,
) {
	const parsed = SearchRequestSchema.safeParse(input);
	if (!parsed.success) throw new ValidationError('Invalid search request');
	if (!deps.search) throw new NotFoundError('Search is not enabled');
	if (!budgetFor(deps.search).consume(principal.id))
		throw new ResourceExhaustedError('Too many searches. Try again in a minute.');
	return deps.search.service.search(principal, parsed.data, signal);
}
