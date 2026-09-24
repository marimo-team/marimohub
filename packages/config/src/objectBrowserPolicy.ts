import { ObjectBrowseError } from '@marimo-hub/core/ports/object-browser';
import type {
	ObjectBrowser,
	ObjectBrowseContext,
	ObjectStoreProvider,
	ObjectStoreSourceFor,
} from '@marimo-hub/core/ports/object-browser';

export function protectControlPlaneBucket<P extends ObjectStoreProvider>(
	browser: ObjectBrowser<P>,
	bucket: string | undefined,
): ObjectBrowser<P> {
	if (!bucket) return browser;
	const denied = (source: ObjectStoreSourceFor<P>, requested?: string) =>
		source.auth.method === 'ambient' && requested === bucket;
	const assert = (source: ObjectStoreSourceFor<P>, requested: string) => {
		if (denied(source, requested))
			throw new ObjectBrowseError(
				'access_denied',
				'Control-plane storage is not available through ambient credentials.',
			);
	};
	const guarded =
		<R extends { bucket: string }, T>(
			method: (
				source: ObjectStoreSourceFor<P>,
				context: ObjectBrowseContext,
				request: R,
			) => Promise<T>,
		) =>
		async (
			source: ObjectStoreSourceFor<P>,
			context: ObjectBrowseContext,
			request: R,
		): Promise<T> => {
			assert(source, request.bucket);
			return method.call(browser, source, context, request);
		};
	return {
		provider: browser.provider,
		async capability(source, context) {
			const result = await browser.capability(source, context);
			return denied(source, source.configured_bucket)
				? {
						...result,
						available: false,
						preview: false,
						download: false,
						reason: 'Control-plane storage is not available through ambient credentials.',
					}
				: result;
		},
		async listBuckets(source, context, request) {
			if (source.configured_bucket) assert(source, source.configured_bucket);
			const page = await browser.listBuckets(source, context, request);
			return { ...page, items: page.items.filter((item) => !denied(source, item.name)) };
		},
		listObjects: guarded(browser.listObjects),
		searchObjects: guarded(browser.searchObjects),
		headObject: guarded(browser.headObject),
		listVersions: guarded(browser.listVersions),
		previewObject: guarded(browser.previewObject),
		openObject: guarded(browser.openObject),
	};
}
