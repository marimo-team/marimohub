import {
	NotFoundError,
	ResourceExhaustedError,
	ValidationError,
	createSlidingWindowBudget,
} from '@marimo-hub/core';
import type { AuthenticatedPrincipal, SlidingWindowBudget } from '@marimo-hub/core';
import { SearchRequestSchema } from '@marimo-hub/core/search';
import type { ApiDeps } from '../context';

export const SEARCH_QUERIES_PER_MINUTE = 30;

// Keyed by the configured search bundle so REST and MCP share one per-user budget.
const budgets = new WeakMap<NonNullable<ApiDeps['search']>, SlidingWindowBudget<string>>();

function budgetFor(search: NonNullable<ApiDeps['search']>): SlidingWindowBudget<string> {
	let budget = budgets.get(search);
	if (!budget) {
		budget = createSlidingWindowBudget({ limit: SEARCH_QUERIES_PER_MINUTE, windowMs: 60_000 });
		budgets.set(search, budget);
	}
	return budget;
}

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
