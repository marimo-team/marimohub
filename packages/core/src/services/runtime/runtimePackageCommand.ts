import { mergeRuntimePackages } from '../integrations/runtimePackages';
import { shellQuote } from './shell';

export const MARIMO_VERSION_COMMAND = `uv run --no-sync python -c ${shellQuote('from importlib.metadata import version; print(version("marimo"))')}`;

export function runtimePackageCommand(packages: readonly string[], command: string): string {
	const requirements = mergeRuntimePackages(packages);
	if (requirements.length === 0) return `uv run --no-sync ${command}`;

	// Match the image-owned marimo version instead of letting a tool replace it.
	const flags = requirements.map((requirement) => `--with ${shellQuote(requirement)}`).join(' ');
	// uv discards its temporary overlay on exit, so a separate preflight repeats resolution.
	return `marimohub_marimo_version=$(${MARIMO_VERSION_COMMAND}) && uv run --no-sync --with "marimo==$marimohub_marimo_version" ${flags} ${command}`;
}
