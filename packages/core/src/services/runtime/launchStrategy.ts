import type { Bucket } from '../../ports/bucket';
import { DEFAULT_LAUNCH_STRATEGY } from './marimoLaunch';
import type { MarimoLaunchStrategyName } from './marimoLaunch';
import { hasInlineScriptMetadata } from './pep723';

export interface ResolvedLaunchStrategy {
	strategy: MarimoLaunchStrategyName;
	/** The synced entry file could not be read; fell back to the default. */
	detectionFailed: boolean;
}

/**
 * Infers the launch strategy per source — no user-facing configuration. Local
 * notebooks (no `workspacePrefix`) always use the project-managed env; synced
 * notebooks get `uv-script-pins` when their entry file declares PEP 723
 * metadata (one GET of the immutable workspace). Never throws: a failed read
 * falls back to the default, and the provision itself fails later if the file
 * truly doesn't exist.
 *
 * Future (#143): markdown entries resolve to `uv-sandbox` here — their
 * metadata lives in YAML frontmatter uv can't parse.
 */
export async function resolveLaunchStrategyForSession(opts: {
	entryNotebook: string;
	/** Synced sources only: `versions/{vid}/workspace/`. */
	workspacePrefix?: string;
	bucket: Bucket;
}): Promise<ResolvedLaunchStrategy> {
	if (!opts.workspacePrefix) {
		return { strategy: DEFAULT_LAUNCH_STRATEGY, detectionFailed: false };
	}
	try {
		const object = await opts.bucket.get(opts.workspacePrefix + opts.entryNotebook);
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
