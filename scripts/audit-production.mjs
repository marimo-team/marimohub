import { spawnSync } from 'node:child_process';

const allowedAdvisories = new Map([
	['GHSA-qwww-vcr4-c8h2', 'React Router unstable RSC APIs are not used by the marimohub SPA.'],
]);

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const result = spawnSync(pnpm, ['audit', '--prod', '--json'], { encoding: 'utf8' });
if (result.error) throw result.error;

let report;
try {
	report = JSON.parse(result.stdout);
} catch {
	process.stderr.write(result.stderr || result.stdout);
	process.exit(1);
}

const advisories = Object.values(report.advisories ?? {});
const blocking = advisories.filter(
	(advisory) =>
		(advisory.severity === 'high' || advisory.severity === 'critical') &&
		!allowedAdvisories.has(advisory.github_advisory_id),
);

for (const advisory of advisories) {
	const reason = allowedAdvisories.get(advisory.github_advisory_id);
	if (reason) {
		process.stdout.write(`Allowed ${advisory.github_advisory_id}: ${reason}\n`);
	}
}

if (blocking.length > 0) {
	for (const advisory of blocking) {
		process.stderr.write(
			`${advisory.severity.toUpperCase()} ${advisory.github_advisory_id}: ${advisory.title}\n`,
		);
	}
	process.exit(1);
}

process.stdout.write('No unapproved high or critical production dependency advisories.\n');
