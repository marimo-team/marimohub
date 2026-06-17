import { useCapabilitiesQuery } from '@/api/hooks';
import type { RadioGroupFieldOption } from '@/components/form/fields/RadioGroupField';

/** The picker value meaning "no stored choice — follow the deployment default". */
export const DEFAULT_BASE_IMAGE = 'default';

/** Selectable sandbox images (ordered; first is the default). Empty = no picker. */
export function useSandboxImages(): string[] {
	const { data } = useCapabilitiesQuery();
	return data?.sandbox_images ?? [];
}

export function baseImageOptions(images: string[]): RadioGroupFieldOption[] {
	return [
		{ value: DEFAULT_BASE_IMAGE, label: 'Default', description: images[0] },
		...images.map((image) => ({ value: image, label: image })),
	];
}
