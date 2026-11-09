export function errorFromAbortReason(reason: unknown): Error {
	if (reason instanceof Error) return reason;
	return new DOMException('The operation was aborted.', 'AbortError');
}
