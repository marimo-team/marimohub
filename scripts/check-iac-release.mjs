import { readIacRelease } from './iac-release.mjs';

const { version, manifest } = readIacRelease();
if (manifest.version !== version || process.env.RELEASE_REF !== `refs/tags/v${version}`) {
	throw new Error('Publish requires a release tag matching the root and IaC package versions.');
}
