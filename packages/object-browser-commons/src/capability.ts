import { OBJECT_BROWSE_PROVIDER_METADATA } from '@marimo-hub/core';
import type {
	ObjectBrowseCapability,
	ObjectBrowseError,
	ObjectStoreProvider,
} from '@marimo-hub/core';
import { OBJECT_PREVIEW_FORMATS } from './formats';

export function objectBrowseCapability(
	provider: ObjectStoreProvider,
	mode: 'metadata' | 'full',
	validate: () => void,
	mapError: (error: unknown) => ObjectBrowseError,
): ObjectBrowseCapability {
	try {
		validate();
		return {
			...OBJECT_BROWSE_PROVIDER_METADATA[provider],
			available: true,
			preview: mode === 'full',
			download: mode === 'full',
			search: 'bounded-key-name',
			versions: true,
			preview_formats: mode === 'full' ? [...OBJECT_PREVIEW_FORMATS] : [],
		};
	} catch (error) {
		return {
			...OBJECT_BROWSE_PROVIDER_METADATA[provider],
			available: false,
			preview: false,
			download: false,
			search: 'none',
			versions: false,
			preview_formats: [],
			reason: mapError(error).message,
		};
	}
}
