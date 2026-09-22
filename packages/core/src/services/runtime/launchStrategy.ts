import type { Bucket } from '../../ports/bucket';
import { DEFAULT_LAUNCH_STRATEGY } from './marimoLaunch';
import type { MarimoLaunchStrategyName } from './marimoLaunch';
import { hasInlineScriptMetadata } from './pep723';

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
	try {
		const object = await opts.bucket.get(opts.entryNotebookKey);
		if (!object) return { strategy: DEFAULT_LAUNCH_STRATEGY, detectionFailed: true };
		return {
			strategy: hasInlineScriptMetadata(await object.text())
				? 'uv-script-pins'
				: DEFAULT_LAUNCH_STRATEGY,
			detectionFailed: false,
		};
	} catch {
		return { strategy: DEFAULT_LAUNCH_STRATEGY, detectionFailed: true };
	}
}
