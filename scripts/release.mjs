import { execFileSync } from 'node:child_process';

const version = process.argv[2];
if (
	!['patch', 'minor', 'major'].includes(version) &&
	!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
) {
	throw new Error('usage: pnpm release <X.Y.Z | patch | minor | major>');
}
execFileSync(
	'gh',
	['workflow', 'run', 'release-pr.yml', '--ref', 'main', '-f', `version=${version}`],
	{ stdio: 'inherit' },
);
console.log(
	'Release preparation dispatched. Follow it with gh run list --workflow release-pr.yml.',
);
