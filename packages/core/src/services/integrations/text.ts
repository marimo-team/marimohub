import { z } from 'zod';

export function boundedText(bytes: number, description: string) {
	return z
		.string()
		.max(bytes)
		.refine((value) => new TextEncoder().encode(value).length <= bytes, {
			message: `Must be at most ${bytes} UTF-8 bytes`,
		})
		.meta({
			'x-max-utf8-bytes': bytes,
			description: `${description}. Maximum ${bytes} UTF-8 bytes.`,
		});
}
