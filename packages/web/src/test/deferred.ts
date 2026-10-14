export interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
}

// Hand-rolled because the package targets ES2023, which lacks Promise.withResolvers.
export function deferred<T = void>(): Deferred<T> {
	let resolve!: Deferred<T>['resolve'];
	let reject!: Deferred<T>['reject'];
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
