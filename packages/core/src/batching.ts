export function batchByWeight<T>(
	items: readonly T[],
	options: {
		weight: (item: T) => number;
		maxWeight: number;
		maxItems?: number;
		overhead?: number;
	},
): T[][] {
	const batches: T[][] = [];
	let batch: T[] = [];
	let weight = options.overhead ?? 0;
	for (const item of items) {
		const itemWeight = options.weight(item);
		// Oversized items still get their own batch; admission policy belongs to the caller.
		if (
			batch.length > 0 &&
			(batch.length >= (options.maxItems ?? Infinity) || weight + itemWeight > options.maxWeight)
		) {
			batches.push(batch);
			batch = [];
			weight = options.overhead ?? 0;
		}
		batch.push(item);
		weight += itemWeight;
	}
	if (batch.length > 0) batches.push(batch);
	return batches;
}
