import { execFileSync } from 'node:child_process';
import { isStableVersion } from './release-version.mjs';

const version = process.argv[2];
if (!['patch', 'minor', 'major'].includes(version) && !isStableVersion(version)) {
	throw new Error('usage: pnpm release <X.Y.Z | patch | minor | major>');
}
execFileSync(
	'gh',
	['workflow', 'run', 'release-pr.yml', '--repo', 'marimo-team/marimohub', '--ref', 'main', '-f', `version=${version}`],
	{ stdio: 'inherit' },
);
console.log(
	'Release preparation dispatched. Follow it with gh run list --workflow release-pr.yml.',
);
