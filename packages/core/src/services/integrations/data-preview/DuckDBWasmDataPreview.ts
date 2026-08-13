import { ResourceExhaustedError, UnavailableError } from '../../../errors';
import { withDeadline } from '../../../internal/async';
import { assertPositiveIntegers } from '../../../internal/validation';
import { noopMetrics } from '../../../ports/metrics';
import type { Metrics } from '../../../ports/metrics';
import type { TablePreview } from '../../../ports/integrations';
import type {
	DuckDBPreviewProgram,
	DuckDBWasmRuntime,
	DuckDBWasmRuntimeFactory,
	PreviewExecutorStatus,
	PreviewRuntimeFeature,
} from './programs';

export interface DuckDBWasmDataPreviewOptions {
	memoryLimitMb: number;
	startupTimeoutMs: number;
	executionTimeoutMs: number;
	maxPoolSize?: number;
	idleTimeoutMs?: number;
	metrics?: Metrics;
}

interface RuntimeSlot {
	runtime: DuckDBWasmRuntime;
	busy: boolean;
	idleTimer?: ReturnType<typeof setTimeout>;
	controller?: AbortController;
	disposing?: Promise<void>;
}

interface RuntimeCapabilities {
	runtime: DuckDBWasmRuntime['mode'];
	features: readonly PreviewRuntimeFeature[];
}

type RecycleReason = 'execution_error' | 'timeout' | 'health_check' | 'idle' | 'shutdown';
const MAX_TIMER_DURATION_MS = 2_147_483_647;

class DuckDBExecutionTimeoutError extends Error {
	name = 'DuckDBExecutionTimeoutError';
}
class DuckDBHealthCheckError extends Error {
	name = 'DuckDBHealthCheckError';
}

export class DuckDBWasmDataPreview {
	private readonly slots = new Set<RuntimeSlot>();
	private readonly initializations = new Set<Promise<unknown>>();
	private readonly initializationDisposers = new Set<() => Promise<void>>();
	private readonly activeWork = new Set<Promise<unknown>>();
	private readonly disposals = new Set<Promise<unknown>>();
	private readonly maxPoolSize: number;
	private readonly idleTimeoutMs: number;
	private readonly metrics: Metrics;
	private capabilities: RuntimeCapabilities | undefined;
	private checking: Promise<void> | undefined;
	private closing: Promise<void> | undefined;
	private readyForTraffic = false;
	private closed = false;

	constructor(
		private readonly runtimeFactory: DuckDBWasmRuntimeFactory,
		private readonly options: DuckDBWasmDataPreviewOptions,
	) {
		this.maxPoolSize = options.maxPoolSize ?? 1;
		assertPositiveIntegers({
			memoryLimitMb: options.memoryLimitMb,
			startupTimeoutMs: options.startupTimeoutMs,
			executionTimeoutMs: options.executionTimeoutMs,
			maxPoolSize: this.maxPoolSize,
		});
		this.idleTimeoutMs = options.idleTimeoutMs ?? 0;
		if (!Number.isSafeInteger(this.idleTimeoutMs) || this.idleTimeoutMs < 0) {
			throw new Error(`idleTimeoutMs must be a non-negative integer, got ${this.idleTimeoutMs}`);
		}
		this.metrics = options.metrics ?? noopMetrics;
	}

	available(): boolean {
		return this.readyForTraffic && !this.closed;
	}

	status(): PreviewExecutorStatus {
		return {
			available: this.available(),
			...this.capabilities,
		};
	}

	supportsFeatures(features: readonly PreviewRuntimeFeature[]): boolean {
		if (!this.available() || !this.capabilities) return false;
		return features.every((feature) => this.capabilities?.features.includes(feature));
	}

	supports(program: DuckDBPreviewProgram): boolean {
		return this.supportsFeatures(program.requires ?? []);
	}

	check(): Promise<void> {
		if (this.available()) return Promise.resolve();
		if (this.closed) return Promise.reject(new UnavailableError('DuckDB-Wasm is closed.'));
		if (this.checking) return this.checking;
		this.checking = this.initializeForPreflight().finally(() => {
			this.checking = undefined;
		});
		return this.checking;
	}

	preview(program: DuckDBPreviewProgram): Promise<TablePreview> {
		if (!this.supports(program)) {
			return Promise.reject(
				new UnavailableError('DuckDB-Wasm cannot execute this preview program.'),
			);
		}
		return this.track(this.activeWork, this.executePreview(program));
	}

	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.readyForTraffic = false;
		this.closing = this.closeAll();
		return this.closing;
	}

	private async initializeForPreflight(): Promise<void> {
		const slot = await this.startSlot();
		if (this.closed) {
			await this.disposeSlot(slot, 'shutdown');
			throw new UnavailableError('DuckDB-Wasm was closed during initialization.');
		}
		this.readyForTraffic = true;
		this.scheduleIdle(slot);
	}

	private async executePreview(program: DuckDBPreviewProgram): Promise<TablePreview> {
		const queuedAt = Date.now();
		let slot: RuntimeSlot;
		try {
			slot = await this.acquireSlot();
		} catch (error) {
			if (error instanceof ResourceExhaustedError) throw error;
			throw new UnavailableError('DuckDB-Wasm could not start a preview runtime.');
		}
		const runtime = slot.runtime;
		const controller = new AbortController();
		slot.controller = controller;
		const tags = { executor: 'duckdb_wasm', runtime: runtime.mode };
		this.metrics.gauge('data_preview.duckdb.queue_wait_ms', Date.now() - queuedAt, tags);
		this.metrics.gauge('data_preview.duckdb.active', this.activeCount(), tags);
		const startedAt = Date.now();
		try {
			const result = await withDeadline(runtime.execute(program, controller.signal), {
				timeoutMs: this.options.executionTimeoutMs,
				timeoutError: () => {
					controller.abort();
					return new DuckDBExecutionTimeoutError();
				},
			});
			if (this.closed || controller.signal.aborted) {
				throw new UnavailableError('DuckDB-Wasm was closed during preview execution.');
			}
			let healthy = true;
			try {
				await withDeadline(runtime.ping(), {
					timeoutMs: this.options.executionTimeoutMs,
					timeoutError: () => new DuckDBHealthCheckError(),
				});
			} catch {
				healthy = false;
				void this.disposeSlot(slot, 'health_check');
			}
			this.metrics.increment('data_preview.duckdb.execution', 1, { ...tags, outcome: 'success' });
			this.metrics.gauge('data_preview.duckdb.rows', result.rows.length, tags);
			if (healthy) this.releaseSlot(slot);
			return result;
		} catch (error) {
			controller.abort();
			const reason: RecycleReason =
				error instanceof DuckDBExecutionTimeoutError ? 'timeout' : 'execution_error';
			this.metrics.increment('data_preview.duckdb.execution', 1, { ...tags, outcome: reason });
			await this.disposeSlot(slot, reason);
			throw new UnavailableError(
				reason === 'timeout'
					? 'DuckDB-Wasm preview timed out.'
					: 'DuckDB-Wasm could not preview this table.',
			);
		} finally {
			slot.controller = undefined;
			this.metrics.gauge('data_preview.duckdb.execution_ms', Date.now() - startedAt, tags);
			this.metrics.gauge('data_preview.duckdb.active', this.activeCount(), tags);
		}
	}

	private async acquireSlot(): Promise<RuntimeSlot> {
		if (!this.available()) {
			throw new UnavailableError('DuckDB-Wasm cannot execute this preview program.');
		}
		for (const slot of this.slots) {
			if (slot.busy || slot.disposing) continue;
			this.clearIdle(slot);
			slot.busy = true;
			return slot;
		}
		if (this.liveRuntimeCount() >= this.maxPoolSize) {
			throw new ResourceExhaustedError('The DuckDB-Wasm preview pool is currently full.');
		}
		const slot = await this.startSlot();
		if (this.closed) {
			await this.disposeSlot(slot, 'shutdown');
			throw new UnavailableError('DuckDB-Wasm is closed.');
		}
		slot.busy = true;
		return slot;
	}

	private startSlot(): Promise<RuntimeSlot> {
		return this.track(this.initializations, this.initializeSlot());
	}

	private track<T>(pending: Set<Promise<unknown>>, work: Promise<T>): Promise<T> {
		pending.add(work);
		void work.then(
			() => pending.delete(work),
			() => pending.delete(work),
		);
		return work;
	}

	private async initializeSlot(): Promise<RuntimeSlot> {
		const startedAt = Date.now();
		let runtime: DuckDBWasmRuntime | undefined;
		let abandoned = false;
		let disposed = false;
		const dispose = async (): Promise<void> => {
			if (!runtime || disposed) return;
			disposed = true;
			await this.closeRuntime(runtime);
		};
		this.initializationDisposers.add(dispose);
		const ensureNotAbandoned = async (): Promise<void> => {
			if (!abandoned && !this.closed) return;
			await dispose();
			throw new UnavailableError('DuckDB-Wasm initialization was abandoned.');
		};
		const startup = (async (): Promise<RuntimeSlot> => {
			runtime = await this.runtimeFactory();
			await ensureNotAbandoned();
			await runtime.initialize({ memoryLimitMb: this.options.memoryLimitMb });
			await ensureNotAbandoned();
			await runtime.ping();
			await ensureNotAbandoned();
			const capabilities = { runtime: runtime.mode, features: [...runtime.features] };
			if (this.capabilities && !sameCapabilities(this.capabilities, capabilities)) {
				await dispose();
				throw new UnavailableError('DuckDB-Wasm runtime capabilities changed within the pool.');
			}
			this.capabilities = capabilities;
			const slot = { runtime, busy: false };
			this.slots.add(slot);
			this.recordPoolSize(runtime.mode);
			return slot;
		})();
		try {
			const slot = await withDeadline(startup, {
				timeoutMs: this.options.startupTimeoutMs,
				timeoutError: () => new UnavailableError('DuckDB-Wasm initialization timed out.'),
			});
			this.metrics.increment('data_preview.duckdb.initialize', 1, {
				runtime: slot.runtime.mode,
				outcome: 'success',
			});
			this.metrics.gauge('data_preview.duckdb.initialize_ms', Date.now() - startedAt, {
				runtime: slot.runtime.mode,
			});
			return slot;
		} catch (error) {
			abandoned = true;
			await dispose();
			this.metrics.increment('data_preview.duckdb.initialize', 1, { outcome: 'failure' });
			throw error;
		} finally {
			this.initializationDisposers.delete(dispose);
		}
	}

	private releaseSlot(slot: RuntimeSlot): void {
		slot.busy = false;
		this.scheduleIdle(slot);
	}

	private scheduleIdle(slot: RuntimeSlot): void {
		if (this.idleTimeoutMs === 0 || this.closed || slot.busy || slot.disposing) return;
		this.clearIdle(slot);
		this.armIdleTimer(slot, Date.now());
	}

	private armIdleTimer(slot: RuntimeSlot, idleStartedAt: number): void {
		const elapsed = Math.max(0, Date.now() - idleStartedAt);
		const remaining = Math.max(0, this.idleTimeoutMs - elapsed);
		const delay = Math.min(remaining, MAX_TIMER_DURATION_MS);
		slot.idleTimer = setTimeout(() => {
			if (slot.busy || this.closed || slot.disposing) return;
			if (Date.now() - idleStartedAt < this.idleTimeoutMs) {
				this.armIdleTimer(slot, idleStartedAt);
				return;
			}
			void this.disposeSlot(slot, 'idle');
		}, delay);
		unrefTimer(slot.idleTimer);
	}

	private clearIdle(slot: RuntimeSlot): void {
		if (slot.idleTimer) clearTimeout(slot.idleTimer);
		slot.idleTimer = undefined;
	}

	private disposeSlot(slot: RuntimeSlot, reason: RecycleReason): Promise<void> {
		if (slot.disposing) return slot.disposing;
		this.clearIdle(slot);
		this.slots.delete(slot);
		slot.controller?.abort();
		this.metrics.increment('data_preview.duckdb.recycle', 1, {
			runtime: slot.runtime.mode,
			reason,
		});
		this.recordPoolSize(slot.runtime.mode);
		slot.disposing = this.closeRuntime(slot.runtime);
		return slot.disposing;
	}

	private async closeRuntime(runtime: DuckDBWasmRuntime): Promise<void> {
		const close = this.track(
			this.disposals,
			Promise.resolve().then(() => runtime.close()),
		);
		await withDeadline(close, {
			timeoutMs: this.options.startupTimeoutMs,
			timeoutError: () => new UnavailableError('DuckDB-Wasm cleanup timed out.'),
		}).catch(() => {});
	}

	private async closeAll(): Promise<void> {
		for (const slot of this.slots) slot.controller?.abort();
		await Promise.allSettled(
			[...this.initializationDisposers].map((dispose) => Promise.resolve().then(dispose)),
		);
		await Promise.allSettled([...this.slots].map((slot) => this.disposeSlot(slot, 'shutdown')));
		await withDeadline(Promise.allSettled(this.initializations), {
			timeoutMs: this.options.startupTimeoutMs,
			timeoutError: () => new UnavailableError('DuckDB-Wasm initialization did not stop in time.'),
		}).catch(() => {});
		await withDeadline(Promise.allSettled(this.disposals), {
			timeoutMs: this.options.startupTimeoutMs,
			timeoutError: () => new UnavailableError('DuckDB-Wasm cleanup did not stop in time.'),
		}).catch(() => {});
		await withDeadline(Promise.allSettled(this.activeWork), {
			timeoutMs: this.options.executionTimeoutMs + this.options.startupTimeoutMs,
			timeoutError: () => new UnavailableError('DuckDB-Wasm active previews did not stop in time.'),
		}).catch(() => {});
		this.capabilities = undefined;
	}

	private activeCount(): number {
		let active = 0;
		for (const slot of this.slots) if (slot.busy) active++;
		return active;
	}

	private liveRuntimeCount(): number {
		return this.slots.size + this.initializations.size + this.disposals.size;
	}

	private recordPoolSize(runtime: DuckDBWasmRuntime['mode']): void {
		this.metrics.gauge('data_preview.duckdb.pool_size', this.slots.size, { runtime });
	}
}

function sameCapabilities(left: RuntimeCapabilities, right: RuntimeCapabilities): boolean {
	return (
		left.runtime === right.runtime &&
		left.features.length === right.features.length &&
		left.features.every((feature) => right.features.includes(feature))
	);
}

function unrefTimer(timer: unknown): void {
	if (
		typeof timer === 'object' &&
		timer !== null &&
		'unref' in timer &&
		typeof timer.unref === 'function'
	) {
		timer.unref();
	}
}
