import { ValidationError } from '../../errors';

// Only pinned index packages: URLs, local paths, markers, and installer flags are not this contract.
const REQUIREMENT = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)(?:\[([a-zA-Z0-9,_-]+)\])?==(\d+\.\d+\.\d+)$/;

function normalizePackageName(name: string): string {
	return name.toLowerCase().replaceAll(/[-_.]+/g, '-');
}

export function mergeRuntimePackages(requirements: readonly string[]): string[] {
	const packages = new Map<string, { version: string; extras: Set<string> }>();
	for (const requirement of requirements) {
		const match = REQUIREMENT.exec(requirement);
		if (!match || match[0] !== requirement)
			throw new ValidationError('Runtime packages must be pinned index requirements.');
		const [, rawName, extras, version] = match;
		const name = normalizePackageName(rawName);
		if (name === 'marimo') throw new ValidationError('The sandbox owns the marimo version.');
		const existing = packages.get(name);
		if (existing && existing.version !== version)
			throw new ValidationError(
				`Integrations require different versions of runtime package "${name}".`,
			);
		const entry = existing ?? { version, extras: new Set<string>() };
		for (const extra of extras?.split(',') ?? []) {
			if (!extra) throw new ValidationError('Runtime package extras must not be empty.');
			entry.extras.add(normalizePackageName(extra));
		}
		packages.set(name, entry);
	}
	return [...packages]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, { version, extras }]) => {
			const suffix = extras.size > 0 ? `[${[...extras].sort().join(',')}]` : '';
			return `${name}${suffix}==${version}`;
		});
}
