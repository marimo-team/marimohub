import { ValidationError } from '../../errors';

// Only pinned index packages: URLs, local paths, markers, and installer flags are not this contract.
const IDENTIFIER = '[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?';
const REQUIREMENT = new RegExp(
	`^(${IDENTIFIER})(?:\\[(${IDENTIFIER}(?:,${IDENTIFIER})*)\\])?==(\\d+\\.\\d+\\.\\d+)$`,
);

interface OwnedRuntimePackage {
	requirement: string;
	owner: string;
}

function normalizePackageName(name: string): string {
	return name.toLowerCase().replaceAll(/[-_.]+/g, '-');
}

export function mergeRuntimePackages(
	requirements: readonly (string | OwnedRuntimePackage)[],
): string[] {
	const packages = new Map<string, { version: string; extras: Set<string>; owners: Set<string> }>();
	for (const input of requirements) {
		const { requirement, owner } =
			typeof input === 'string' ? { requirement: input, owner: undefined } : input;
		const match = REQUIREMENT.exec(requirement);
		if (!match || match[0] !== requirement)
			throw new ValidationError('Runtime packages must be pinned index requirements.');
		const [, rawName, extras, version] = match;
		const name = normalizePackageName(rawName);
		if (name === 'marimo') throw new ValidationError('The sandbox owns the marimo version.');
		const existing = packages.get(name);
		const owners = existing?.owners ?? new Set<string>();
		if (owner) owners.add(owner);
		if (existing && existing.version !== version)
			throw new ValidationError(
				`Integrations${owners.size > 0 ? ` ${[...owners].map((name) => `"${name}"`).join(', ')}` : ''} require different versions of runtime package "${name}".`,
			);
		const entry = existing ?? { version, extras: new Set<string>(), owners };
		for (const extra of extras?.split(',') ?? []) {
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
