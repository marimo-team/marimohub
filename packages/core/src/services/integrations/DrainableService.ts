import { InFlightWork } from '../../concurrency';

export abstract class DrainableService {
	protected readonly inFlight = new InFlightWork();
	protected closed = false;
	private closing: Promise<void> | undefined;

	protected track<T>(work: Promise<T>): Promise<T> {
		return this.inFlight.track(work);
	}

	protected closeOnce(shutdown: () => Promise<void>): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.closing = Promise.resolve().then(shutdown);
		return this.closing;
	}
}
