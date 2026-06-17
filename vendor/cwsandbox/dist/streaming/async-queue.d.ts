export declare class AsyncQueue<T> implements AsyncIterable<T> {
    private readonly capacity;
    private readonly items;
    private readonly waitingConsumers;
    private readonly waitingProducers;
    private closed;
    private consumed;
    private error;
    constructor(capacity?: number);
    [Symbol.asyncIterator](): AsyncIterator<T>;
    close(): void;
    fail(error: unknown): void;
    push(item: T): Promise<void>;
    tryPush(item: T): boolean;
    private drainConsumers;
    private next;
    private releaseProducer;
    private releaseProducers;
}
//# sourceMappingURL=async-queue.d.ts.map