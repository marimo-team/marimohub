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

export interface WeakMemo<K extends object, V> {
	(key: K): V;
	/** Forget every memoized value so tests can start from fresh shared state. */
	clear(): void;
}

/**
 * Memoize one value per owner object without retaining the owner. Holds caches and
 * budgets that live as long as a dependency bundle, bucket, or config object does.
 */
export function weakMemo<K extends object, V>(create: (key: K) => V): WeakMemo<K, V> {
	let values = new WeakMap<K, V>();
	const memo = ((key: K): V => {
		if (values.has(key)) return values.get(key) as V;
		const value = create(key);
		values.set(key, value);
		return value;
	}) as WeakMemo<K, V>;
	memo.clear = () => {
		values = new WeakMap();
	};
	return memo;
}

export interface LazyMapOptions {
	maxSize: number;
}

interface Pending<V> {
	promise: Promise<V>;
	state: { superseded: boolean };
}

/** Map bounded to `maxSize` entries that evicts the least recently used on insert. */
export class BoundedLruMap<K, V> {
	private readonly values = new Map<K, V>();

	constructor(private readonly maxSize: number) {
		if (!Number.isInteger(maxSize) || maxSize <= 0) {
			throw new RangeError('maxSize must be a positive integer');
		}
	}

	get size(): number {
		return this.values.size;
	}

	has(key: K): boolean {
		return this.values.has(key);
	}

	/** Returns the value and marks it most recently used. */
	get(key: K): V | undefined {
		if (!this.values.has(key)) return undefined;
		const value = this.values.get(key) as V;
		this.values.delete(key);
		this.values.set(key, value);
		return value;
	}

	/** Returns the value without changing eviction order. */
	peek(key: K): V | undefined {
		return this.values.get(key);
	}

	set(key: K, value: V): void {
		this.values.delete(key);
		this.values.set(key, value);
		while (this.values.size > this.maxSize) {
			const oldest = this.values.keys().next();
			if (oldest.done) return;
			this.values.delete(oldest.value);
		}
	}

	delete(key: K): boolean {
		return this.values.delete(key);
	}

	clear(): void {
		this.values.clear();
	}
}

/**
 * Shares one in-flight promise per key and forgets it on settlement, so a burst of
 * concurrent callers costs one load and the next call after it loads again. Compare
 * `cachedRead`, which keeps results for the owner's lifetime, and `LazyMap`, which
 * caches values.
 */
export class SingleFlight<K, V> {
	private readonly pending = new Map<K, Promise<V>>();

	get size(): number {
		return this.pending.size;
	}

	has(key: K): boolean {
		return this.pending.has(key);
	}

	run(key: K, load: () => Promise<V>): Promise<V> {
		const existing = this.pending.get(key);
		if (existing) return existing;
		let started: Promise<V>;
		try {
			started = load();
		} catch (error) {
			started = Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
		const promise = started.finally(() => {
			if (this.pending.get(key) === promise) this.pending.delete(key);
		});
		this.pending.set(key, promise);
		return promise;
	}

	/** Later callers start a new load; the dropped promise still settles for its callers. */
	delete(key: K): boolean {
		return this.pending.delete(key);
	}
}

interface MemoEntry<T = unknown> {
	promise: Promise<T>;
	settled: boolean;
	value?: T;
}

interface MemoNode {
	children: Map<unknown, MemoNode>;
	entry?: MemoEntry;
}

/** One request or operation owns a memo. Key elements use Map equality (SameValueZero). */
export class PromiseMemo {
	private readonly root: MemoNode = { children: new Map() };

	read<T>(
		key: readonly unknown[],
		load: () => T | PromiseLike<T>,
		options: { isValid?: (value: T) => boolean } = {},
	): Promise<T> {
		let node = this.root;
		for (const part of key) {
			let child = node.children.get(part);
			if (!child) {
				child = { children: new Map() };
				node.children.set(part, child);
			}
			node = child;
		}
		const existing = node.entry;
		try {
			if (
				existing &&
				(!existing.settled || !options.isValid || options.isValid(existing.value as T))
			) {
				return existing.promise as Promise<T>;
			}
		} catch (error) {
			if (node.entry === existing) delete node.entry;
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
		const entry: MemoEntry<T> = { promise: Promise.resolve().then(load), settled: false };
		entry.promise = entry.promise
			.then((value) => {
				entry.value = value;
				entry.settled = true;
				if (options.isValid && !options.isValid(value) && node.entry === entry) delete node.entry;
				return value;
			})
			.catch((error: unknown) => {
				if (node.entry === entry) delete node.entry;
				throw error;
			});
		node.entry = entry;
		return entry.promise;
	}
}

export class LazyMap<K, V> {
	private readonly values: BoundedLruMap<K, V>;
	private readonly pending = new Map<K, Pending<V>>();
	private readonly loadValue?: (key: K) => Promise<V>;

	/** Without a default loader, every load must pass one (`getOrLoad`, `reload({ load })`). */
	constructor(options: LazyMapOptions);
	constructor(loadValue: (key: K) => Promise<V>, options: LazyMapOptions);
	constructor(loadOrOptions: ((key: K) => Promise<V>) | LazyMapOptions, options?: LazyMapOptions) {
		const resolved = typeof loadOrOptions === 'function' ? options : loadOrOptions;
		if (!resolved) throw new TypeError('LazyMap options are required');
		if (typeof loadOrOptions === 'function') this.loadValue = loadOrOptions;
		this.values = new BoundedLruMap(resolved.maxSize);
	}

	get size(): number {
		return this.values.size;
	}

	getIfPresent(key: K): V | undefined {
		return this.values.get(key);
	}

	async get(key: K): Promise<V> {
		if (!this.values.has(key)) return this.reload(key);
		return this.getIfPresent(key) as V;
	}

	reload(key: K, options: { force?: boolean; load?: (key: K) => Promise<V> } = {}): Promise<V> {
		const existing = this.pending.get(key);
		if (existing && !existing.state.superseded && !options.force) return existing.promise;
		if (existing) existing.state.superseded = true;

		const state = { superseded: false };
		const promise = Promise.resolve()
			.then(() => {
				const load = options.load ?? this.loadValue;
				if (!load) throw new Error('LazyMap load function is required');
				return load(key);
			})
			.then((loaded) => {
				if (!state.superseded) {
					this.values.set(key, loaded);
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
		this.values.set(key, value);
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
}

interface TimedValue<V> {
	value: V;
	loadedAt: number;
	nextRefreshAt: number;
}

export interface StaleWhileRevalidateCacheOptions<K, V> {
	/** Without a default loader, every `get` must pass one. */
	load?: (key: K) => Promise<V>;
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
		const { load } = options;
		this.entries = load
			? new LazyMap((key) => this.timed(load, key), { maxSize: options.maxSize })
			: new LazyMap({ maxSize: options.maxSize });
	}

	private async timed(load: (key: K) => Promise<V>, key: K): Promise<TimedValue<V>> {
		const value = await load(key);
		const now = this.now();
		return { value, loadedAt: now, nextRefreshAt: now };
	}

	/** `load` replaces the configured loader for this call only, e.g. when it closes over request state. */
	async get(key: K, load?: (key: K) => Promise<V>): Promise<V> {
		const timed = load === undefined ? undefined : (k: K) => this.timed(load, k);
		const cached = this.entries.getIfPresent(key);
		if (!cached) {
			return (timed ? await this.entries.getOrLoad(key, timed) : await this.entries.get(key)).value;
		}

		const now = this.now();
		switch (ttlState(cached.loadedAt, now, this.options.ttl(cached.value, key))) {
			case 'fresh':
				return cached.value;
			case 'stale':
				this.refreshInBackground(key, cached, now, timed);
				return cached.value;
			case 'expired':
				return (await this.entries.reload(key, timed ? { load: timed } : {})).value;
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

	clear(): void {
		this.entries.clear();
		this.refreshing.clear();
	}

	private refreshInBackground(
		key: K,
		cached: TimedValue<V>,
		now: number,
		load?: (key: K) => Promise<TimedValue<V>>,
	): void {
		if (this.refreshing.has(key) || now < cached.nextRefreshAt) return;
		this.refreshing.add(key);
		this.entries.set(key, { ...cached, nextRefreshAt: now + this.backgroundRetryMs });
		void this.entries
			.reload(key, load ? { load } : {})
			.catch((error) => this.options.onBackgroundError?.(error, key))
			.finally(() => this.refreshing.delete(key));
	}
}
