import { BoundedLruMap } from '../../cache';
import type { Bucket } from '../../ports/bucket';
import { DEFAULT_LAUNCH_STRATEGY } from './marimoLaunch';
import type { MarimoLaunchStrategyName } from './marimoLaunch';
import { hasInlineScriptMetadata } from './pep723';

const versionMetadata = new WeakMap<
	Bucket,
	BoundedLruMap<string, Promise<MarimoLaunchStrategyName | undefined>>
>();

export interface ResolvedLaunchStrategy {
	strategy: MarimoLaunchStrategyName;
	/** The entry file could not be read; fell back to the default. */
	detectionFailed: boolean;
}

/**
 * Read the source selected for launch, including immutable versions used by
 * apps and jobs. A failed read falls back to the project-managed environment.
 *
 * Future (#143): markdown entries resolve to `uv-sandbox` here — their
 * metadata lives in YAML frontmatter uv can't parse.
 */
export async function resolveLaunchStrategyForSession(opts: {
	entryNotebookKey: string;
	bucket: Bucket;
}): Promise<ResolvedLaunchStrategy> {
	// Match the notebook version root, never a workspace directory named "versions".
	const immutable = /^projects\/[^/]+\/notebooks\/[^/]+\/versions\/[^/]+\//.test(
		opts.entryNotebookKey,
	);
	let cache = immutable ? versionMetadata.get(opts.bucket) : undefined;
	if (immutable && !cache) {
		cache = new BoundedLruMap(10_000);
		versionMetadata.set(opts.bucket, cache);
	}
	let pending = cache?.get(opts.entryNotebookKey);
	if (pending === undefined) {
		pending = detectLaunchStrategy(opts.bucket, opts.entryNotebookKey).then((strategy) => {
			if (strategy === undefined && cache?.peek(opts.entryNotebookKey) === pending) {
				cache?.delete(opts.entryNotebookKey);
			}
			return strategy;
		});
		cache?.set(opts.entryNotebookKey, pending);
	}
	const strategy = await pending;
	return { strategy: strategy ?? DEFAULT_LAUNCH_STRATEGY, detectionFailed: strategy === undefined };
}

async function detectLaunchStrategy(
	bucket: Bucket,
	key: string,
): Promise<MarimoLaunchStrategyName | undefined> {
	try {
		const object = await bucket.get(key);
		if (!object) return undefined;
		return hasInlineScriptMetadata(await object.text())
			? 'uv-script-pins'
			: DEFAULT_LAUNCH_STRATEGY;
	} catch {
		return undefined;
	}
}
