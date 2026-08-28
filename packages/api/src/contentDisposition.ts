export function objectContentDisposition(key: string, inline: boolean): string {
	const last = key.split('/').at(-1) || 'download';
	const safe =
		Array.from(last, (character) => {
			const code = character.codePointAt(0) ?? 0;
			return code < 32 || code === 127 || character === '/' || character === '\\' ? '_' : character;
		})
			.slice(0, 255)
			.join('') || 'download';
	const fallback =
		safe
			.normalize('NFKD')
			.replaceAll(/[^\x20-\x7e]/g, '_')
			.replaceAll(/["%;]/g, '_')
			.slice(0, 150) || 'download';
	const encoded = encodeURIComponent(safe).replaceAll(
		/[!'()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
