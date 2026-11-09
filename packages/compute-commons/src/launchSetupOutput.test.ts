import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { buildLaunchCommand, LaunchSetupOutput, setupCompleteMarker } from './index';

describe('LaunchSetupOutput', () => {
	it.each([0, 1, 20, 70])('keeps setup streams across a split completion marker (%i)', (split) => {
		const nonce = 'a'.repeat(32);
		const output = new LaunchSetupOutput(nonce);
		const marker = setupCompleteMarker(nonce);
		output.feed('stdout', `setup stdout\n${marker},"setupMs":10}\n`);
		output.feed('stderr', `setup stderr\n${marker.slice(0, split)}`);
		output.feed(
			'stderr',
			`${marker.slice(split)},"setupMs":10}\n${'kernel noise'.repeat(100_000)}`,
		);
		output.feed('stdout', 'kernel stdout');
		expect(output.complete).toBe(true);
		expect(output.output).toMatchObject({ stdout: 'setup stdout\n', stderr: 'setup stderr\n' });
	});

	it.each(['stdout', 'stderr'] as const)(
		'retains delayed %s setup output after the other stream completes',
		(delayed) => {
			const nonce = 'c'.repeat(32);
			const output = new LaunchSetupOutput(nonce);
			const first = delayed === 'stdout' ? 'stderr' : 'stdout';
			const marker = `${setupCompleteMarker(nonce)},"setupMs":10}\n`;
			output.feed(first, `first setup\n${marker}kernel output`);
			output.feed(delayed, `delayed setup\n${marker}kernel output`);
			expect(output.output[first]).toBe('first setup\n');
			expect(output.output[delayed]).toBe('delayed setup\n');
		},
	);

	it('retains bounded diagnostics when setup fails before completion', () => {
		const output = new LaunchSetupOutput('b'.repeat(32));
		output.feed('stderr', `${'x'.repeat(1_000_000)}\nsetup failed`);
		expect(output.output.stderr.endsWith('setup failed')).toBe(true);
		expect(output.output.stderr.length).toBeLessThan(100_000);
	});
});

it.each([0, 3])(
	'emits separate setup boundaries from the real supervisor (setup exit %i)',
	(exitCode) => {
		const built = buildLaunchCommand({
			setup: `printf 'setup stdout'; printf 'setup stderr' >&2; exit ${exitCode}`,
			command: 'exit 1',
			port: 9,
			startupTimeout: 2000,
		});
		const result = spawnSync('sh', ['-c', built.command], { timeout: 5000, encoding: 'utf8' });
		expect(result.status).toBe(exitCode || 1);
		const output = new LaunchSetupOutput(built.nonce);
		output.feed('stderr', result.stderr);
		output.feed('stdout', result.stdout);
		expect(output.complete).toBe(true);
		expect(output.output).toMatchObject({ stdout: 'setup stdout', stderr: 'setup stderr' });
	},
);
