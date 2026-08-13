export interface TtlPolicy {
	freshForMs: number;
	staleForMs: number;
}

export type TtlState = 'fresh' | 'stale' | 'expired';

function assertDuration(value: number, name: string, allowInfinity = false): void {
	if (value < 0 || Number.isNaN(value) || (!allowInfinity && !Number.isFinite(value))) {
		throw new RangeError(`${name} must be a non-negative duration`);
	}
}

export function ttlState(loadedAt: number, now: number, policy: TtlPolicy): TtlState {
	assertDuration(policy.freshForMs, 'freshForMs');
	assertDuration(policy.staleForMs, 'staleForMs', true);
	const age = Math.max(0, now - loadedAt);
	if (age < policy.freshForMs) return 'fresh';
	if (age < policy.freshForMs + policy.staleForMs) return 'stale';
	return 'expired';
}

export interface LazyMapOptions {
	maxSize: number;
}

interface Pending<V> {
	promise: Promise<V>;
	state: { superseded: boolean };
}

export class LazyMap<K, V> {
	private readonly values = new Map<K, V>();
	private readonly pending = new Map<K, Pending<V>>();

	constructor(
		private readonly loadValue: (key: K) => Promise<V>,
		private readonly options: LazyMapOptions,
	) {
		if (!Number.isInteger(options.maxSize) || options.maxSize <= 0) {
			throw new RangeError('maxSize must be a positive integer');
		}
	}

	get size(): number {
		return this.values.size;
	}

	getIfPresent(key: K): V | undefined {
		if (!this.values.has(key)) return undefined;
		const value = this.values.get(key) as V;
		this.values.delete(key);
		this.values.set(key, value);
		return value;
	}

	async get(key: K): Promise<V> {
		if (!this.values.has(key)) return this.reload(key);
		return this.getIfPresent(key) as V;
	}

	reload(key: K, options: { force?: boolean; load?: (key: K) => Promise<V> } = {}): Promise<V> {
		const existing = this.pending.get(key);
		if (existing && !options.force) return existing.promise;
		if (existing) existing.state.superseded = true;

		const state = { superseded: false };
		const promise = Promise.resolve()
			.then(() => (options.load ?? this.loadValue)(key))
			.then((loaded) => {
				if (!state.superseded) {
					this.store(key, loaded);
					return loaded;
				}
				return this.values.has(key) ? (this.getIfPresent(key) as V) : loaded;
			})
			.finally(() => {
				if (this.pending.get(key)?.state === state) this.pending.delete(key);
			});
		this.pending.set(key, { promise, state });
		return promise;
	}

	getOrLoad(key: K, load: (key: K) => Promise<V>, options: { force?: boolean } = {}): Promise<V> {
		if (!options.force && this.values.has(key)) return Promise.resolve(this.getIfPresent(key) as V);
		return this.reload(key, { ...options, load });
	}

	hasPending(key: K): boolean {
		return this.pending.has(key);
	}

	set(key: K, value: V): void {
		const pending = this.pending.get(key);
		if (pending) pending.state.superseded = true;
		this.store(key, value);
	}

	delete(key: K): boolean {
		const pending = this.pending.get(key);
		if (pending) pending.state.superseded = true;
		return this.values.delete(key);
	}

	clear(): void {
		for (const pending of this.pending.values()) pending.state.superseded = true;
		this.pending.clear();
		this.values.clear();
	}

	private store(key: K, value: V): void {
		this.values.delete(key);
		this.values.set(key, value);
		while (this.values.size > this.options.maxSize) {
			const entry = this.values.keys().next();
			if (entry.done) return;
			this.values.delete(entry.value);
		}
	}
}

interface TimedValue<V> {
	value: V;
	loadedAt: number;
	nextRefreshAt: number;
}

export interface StaleWhileRevalidateCacheOptions<K, V> {
	load: (key: K) => Promise<V>;
	ttl: (value: V, key: K) => TtlPolicy;
	maxSize: number;
	backgroundRetryMs?: number;
	now?: () => number;
	onBackgroundError?: (error: unknown, key: K) => void;
}

export class StaleWhileRevalidateCache<K, V> {
	private readonly entries: LazyMap<K, TimedValue<V>>;
	private readonly refreshing = new Set<K>();
	private readonly now: () => number;
	private readonly backgroundRetryMs: number;

	constructor(private readonly options: StaleWhileRevalidateCacheOptions<K, V>) {
		this.now = options.now ?? (() => Date.now());
		this.backgroundRetryMs = options.backgroundRetryMs ?? 5_000;
		assertDuration(this.backgroundRetryMs, 'backgroundRetryMs');
		this.entries = new LazyMap(
			async (key) => {
				const value = await options.load(key);
				const now = this.now();
				return { value, loadedAt: now, nextRefreshAt: now };
			},
			{ maxSize: options.maxSize },
		);
	}

	async get(key: K): Promise<V> {
		const cached = this.entries.getIfPresent(key);
		if (!cached) return (await this.entries.get(key)).value;

		const now = this.now();
		switch (ttlState(cached.loadedAt, now, this.options.ttl(cached.value, key))) {
			case 'fresh':
				return cached.value;
			case 'stale':
				this.refreshInBackground(key, cached, now);
				return cached.value;
			case 'expired':
				return (await this.entries.reload(key)).value;
		}
	}

	getIfPresent(key: K): V | undefined {
		return this.entries.getIfPresent(key)?.value;
	}

	set(key: K, value: V): void {
		const now = this.now();
		this.entries.set(key, { value, loadedAt: now, nextRefreshAt: now });
	}

	update(key: K, updateValue: (value: V) => V): boolean {
		const cached = this.entries.getIfPresent(key);
		if (!cached) return false;
		this.entries.set(key, { ...cached, value: updateValue(cached.value) });
		return true;
	}

	delete(key: K): boolean {
		return this.entries.delete(key);
	}

	private refreshInBackground(key: K, cached: TimedValue<V>, now: number): void {
		if (this.refreshing.has(key) || now < cached.nextRefreshAt) return;
		this.refreshing.add(key);
		this.entries.set(key, { ...cached, nextRefreshAt: now + this.backgroundRetryMs });
		void this.entries
			.reload(key)
			.catch((error) => this.options.onBackgroundError?.(error, key))
			.finally(() => this.refreshing.delete(key));
	}
}
