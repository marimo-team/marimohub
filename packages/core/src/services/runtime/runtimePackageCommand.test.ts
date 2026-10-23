import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors';
import { runtimePackageCommand } from './runtimePackageCommand';

describe('runtimePackageCommand', () => {
	it('uses the base environment without a version lookup when no packages are requested', () => {
		expect(runtimePackageCommand([], "python 'my launcher.py'")).toBe(
			"uv run --no-sync python 'my launcher.py'",
		);
	});

	it('combines duplicate packages into one resolution and preserves the command', () => {
		const command = "python '/tmp/bridge launcher.py' --quiet edit 'my notebook.py'";
		const result = runtimePackageCommand(
			['Marimo_Studio[typst]==0.4.1', 'marimo-studio[deno]==0.4.1'],
			command,
		);
		expect(result).toContain("--with 'marimo-studio[deno,typst]==0.4.1'");
		expect(result.match(/uv run --no-sync --with/g)).toHaveLength(1);
		expect(result).toContain(') && uv run --no-sync --with "marimo==$marimohub_marimo_version"');
		expect(result.endsWith(command)).toBe(true);
	});

	it.each([['marimo==0.25.2'], ['studio==0.4.1', 'Studio==0.4.2'], ['studio==0.4.1$(id)']])(
		'rejects invalid requirements at the command boundary: %j',
		(...packages) => {
			expect(() => runtimePackageCommand(packages, 'python -m marimo')).toThrow(ValidationError);
		},
	);
});
