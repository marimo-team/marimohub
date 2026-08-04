/** Source repository — the UI derives release/commit + issue links from it. */
export const SOURCE_URL = 'https://github.com/marimo-team/marimohub';

/**
 * MARIMOHUB_VERSION is either a release tag (`0.2.0`) or a git SHA (`a1b2c3d`);
 * only one of those has a release page, so pick the GitHub URL per shape. Any
 * other value (`dev`, git-describe suffixes like `0.2.0-5-gdeadbeef`) has no
 * page at all.
 */
export function versionHref(version: string): string | null {
	if (/^v?\d+\.\d+\.\d+$/.test(version)) {
		return `${SOURCE_URL}/releases/tag/${version.startsWith('v') ? version : `v${version}`}`;
	}
	if (/^[0-9a-f]{7,40}$/i.test(version)) {
		return `${SOURCE_URL}/commit/${version}`;
	}
	return null;
}
