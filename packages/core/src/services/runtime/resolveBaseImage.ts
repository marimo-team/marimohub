/**
 * Resolve a notebook's stored base-image choice against the deployment's
 * configured image list (ordered; `images[0]` is the default).
 *
 * Lenient by design — a session start must never fail because the image list
 * changed after the choice was stored: a stale choice falls back to the default
 * with a `warn`. Strict membership validation happens at the API write path.
 *
 * Returns `undefined` when no images are configured, so the compute adapter's
 * own default applies.
 */
export function resolveBaseImage(
	baseImage: string | undefined,
	images: readonly string[],
	warn: (message: string) => void = console.warn,
): string | undefined {
	if (images.length === 0) return undefined;
	if (!baseImage || baseImage === 'default') return images[0];
	if (images.includes(baseImage)) return baseImage;
	warn(
		`base image "${baseImage}" is no longer in the configured image list; ` +
			`falling back to the default "${images[0]}"`,
	);
	return images[0];
}
