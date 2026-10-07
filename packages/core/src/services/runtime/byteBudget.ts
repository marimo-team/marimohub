/**
 * Process-wide cap on bytes held in memory for optional work. A failed
 * reservation means "do it the slower, unbuffered way", never an error.
 */
export class ByteBudget {
	private reserved = 0;

	constructor(readonly capacity: number) {
		if (!Number.isSafeInteger(capacity) || capacity < 0) {
			throw new RangeError('ByteBudget capacity must be a non-negative integer');
		}
	}

	get available(): number {
		return this.capacity - this.reserved;
	}

	/** Disposing the reservation returns its bytes; disposing twice is a no-op. */
	tryReserve(bytes: number): Disposable | undefined {
		if (!Number.isSafeInteger(bytes) || bytes < 0) {
			throw new RangeError('ByteBudget reservations must be a non-negative integer');
		}
		if (bytes > this.available) return undefined;
		this.reserved += bytes;
		let released = false;
		return {
			[Symbol.dispose]: () => {
				if (released) return;
				released = true;
				this.reserved -= bytes;
			},
		};
	}
}
