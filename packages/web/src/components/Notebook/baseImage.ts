import { useCapabilitiesQuery } from '@/api/hooks';
import type { RadioGroupFieldOption } from '@/components/form/fields/RadioGroupField';

/** The picker value meaning "no stored choice — follow the deployment default". */
export const DEFAULT_BASE_IMAGE = 'default';

/** Selectable sandbox images (ordered; first is the default). Empty = no picker. */
export function useSandboxImages(): string[] {
	const { data } = useCapabilitiesQuery();
	return data?.sandbox_images ?? [];
}

/**
 * The tag convention our published kernel images use — `py3.13-marimo0.23.16`.
 * Matching it is best-effort prettification, never a requirement: any other tag
 * (or a digest pin) falls through to the generic handling in {@link imageLabel}.
 */
const MARIMO_TAG = /^py(\d+(?:\.\d+)*)-marimo(.+)$/;

interface ImageRef {
	/** Everything before the tag/digest, e.g. `ghcr.io/marimo-team/marimo-sandbox`. */
	repository: string;
	tag?: string;
	digest?: string;
}

/**
 * Split an image reference into repository + tag/digest. The tag separator is the
 * last `:` AFTER the last `/`, so a registry port (`localhost:5000/img`) is not
 * mistaken for one.
 */
export function parseImageRef(ref: string): ImageRef {
	const [namePart, digest] = ref.split('@', 2);
	const lastSlash = namePart.lastIndexOf('/');
	const lastColon = namePart.lastIndexOf(':');
	const hasTag = lastColon > lastSlash;
	return {
		repository: hasTag ? namePart.slice(0, lastColon) : namePart,
		tag: hasTag ? namePart.slice(lastColon + 1) : undefined,
		digest,
	};
}

/**
 * A short, human-readable name for an image — the part that distinguishes it from
 * the deployment's other images, since those usually share a repository. The full
 * reference stays visible as the option's description.
 */
export function imageLabel(ref: string): string {
	const { repository, tag, digest } = parseImageRef(ref);
	const marimo = tag?.match(MARIMO_TAG);
	if (marimo) return `marimo ${marimo[2]} · Python ${marimo[1]}`;
	if (tag) return tag;
	// Digest pins have nothing readable, so name the image and abbreviate the hash.
	const name = repository.slice(repository.lastIndexOf('/') + 1);
	if (digest) return `${name}@${digest.replace(/^sha256:/, '').slice(0, 12)}`;
	return name;
}

export function baseImageOptions(images: string[]): RadioGroupFieldOption[] {
	const describe = (image: string) => {
		const label = imageLabel(image);
		// Suppress a description that would just repeat the label (unparseable refs).
		return { value: image, label, description: label === image ? undefined : image };
	};
	const fallback = images[0];
	return [
		{
			value: DEFAULT_BASE_IMAGE,
			label: fallback ? `Default (${imageLabel(fallback)})` : 'Default',
			description: fallback,
		},
		...images.map(describe),
	];
}
