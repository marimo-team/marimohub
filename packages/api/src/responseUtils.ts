export function appendVary(headers: Headers, field: string): void {
	const vary = headers.get('Vary');
	const fields =
		vary
			?.toLowerCase()
			.split(',')
			.map((value) => value.trim()) ?? [];
	if (!fields.includes('*') && !fields.includes(field.toLowerCase())) {
		headers.set('Vary', vary ? `${vary}, ${field}` : field);
	}
}

// Returns the complete size only when the body ends before the exclusive limit.
export async function responseSizeBelow(
	response: Response,
	limit: number,
): Promise<number | undefined> {
	if (!response.body) return 0;
	const reader = response.clone().body!.getReader();
	let size = 0;
	try {
		while (size < limit) {
			const { done, value } = await reader.read();
			if (done) return size;
			size += value.byteLength;
		}
	} finally {
		// A tee's cancel waits for the original body, which the server has yet to send.
		void reader.cancel().catch(() => {});
	}
	return undefined;
}
