import { execFileSync } from 'node:child_process';
import { isStableVersion } from './release-version.mjs';

const version = process.argv[2];
if (!['patch', 'minor', 'major'].includes(version) && !isStableVersion(version)) {
	throw new Error('usage: pnpm release <X.Y.Z | patch | minor | major>');
}
execFileSync('gh', ['release-control', 'request', version], {
	stdio: 'inherit',
	env: { ...process.env, GITHUB_REPOSITORY: 'marimo-team/marimohub' },
});
