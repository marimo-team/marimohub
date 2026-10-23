import { z } from 'zod';

export const TEXT_FILE_MAX_BYTES = 64 * 1024;

export function textFileContent(
	description: string,
	message = 'Content must not be blank or contain NUL characters.',
) {
	return boundedText(TEXT_FILE_MAX_BYTES, description)
		.min(1)
		.refine((value) => value.trim().length > 0 && !value.includes('\0'), { message });
}

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
