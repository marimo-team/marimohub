export function sortIntegrationsByName<T extends { name: string }>(items: readonly T[]): T[] {
	return items.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
