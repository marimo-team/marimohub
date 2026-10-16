import { withAbortSignal } from '@marimo-hub/core/async';
import { BadRequestError, UnavailableError } from '@marimo-hub/core/errors';

export async function readResponseBytes(
	response: Response,
	limit: number,
	provider: string,
	signal?: AbortSignal | null,
): Promise<Uint8Array> {
	if (Number(response.headers.get('content-length')) > limit) {
		await response.body?.cancel().catch(() => {});
		throw new BadRequestError(`${provider} response exceeds the size limit`);
	}
	if (!response.body) throw new UnavailableError(`${provider} returned an empty response`);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			signal?.throwIfAborted();
			const next = await withAbortSignal(reader.read(), signal ?? undefined);
			signal?.throwIfAborted();
			if (next.done) break;
			size += next.value.byteLength;
			if (size > limit) throw new BadRequestError(`${provider} response exceeds the size limit`);
			chunks.push(next.value);
		}
	} catch (error) {
		signal?.throwIfAborted();
		if (error instanceof BadRequestError) throw error;
		throw new UnavailableError(`${provider} response could not be read`, { cause: error });
	} finally {
		await reader.cancel().catch(() => {});
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
