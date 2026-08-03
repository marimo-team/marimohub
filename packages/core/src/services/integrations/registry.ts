import { z } from 'zod';
import { ValidationError } from '../../errors';
import type { KindDescriptor } from '../../ports/integrations';
import type { IntegrationDefinition } from './sdk';
import { secretPaths } from './secretFields';
import type { SecretPath } from './secretFields';

const KIND_REGEX = /^[a-z][a-z0-9_]{1,31}$/;

export class IntegrationRegistry {
	private readonly defs = new Map<string, IntegrationDefinition>();
	private readonly descriptors = new Map<string, KindDescriptor>();
	private readonly paths = new Map<string, SecretPath[]>();

	register(def: IntegrationDefinition): void {
		if (!KIND_REGEX.test(def.kind)) {
			throw new Error(`Invalid integration kind "${def.kind}": must match ${KIND_REGEX}`);
		}
		if (this.defs.has(def.kind)) {
			throw new Error(`Duplicate integration kind "${def.kind}"`);
		}
		this.defs.set(def.kind, def);
	}

	/** Resolves user-supplied kind names or throws a validation error. */
	get(kind: string): IntegrationDefinition {
		const def = this.defs.get(kind);
		if (!def) throw new ValidationError(`Unknown integration kind "${kind}".`);
		return def;
	}

	list(): IntegrationDefinition[] {
		return [...this.defs.values()];
	}

	describe(kind: string): KindDescriptor {
		const cached = this.descriptors.get(kind);
		if (cached) return cached;
		const def = this.get(kind);
		const descriptor: KindDescriptor = {
			kind: def.kind,
			title: def.title,
			description: def.description,
			category: def.category,
			brand: def.brand,
			schema_version: def.schemaVersion,
			json_schema: this.jsonSchema(kind),
			ui_hints: def.uiHints ?? {},
			supports_test: def.testConnection !== undefined,
			secret_sources: { inline: false, references: [] },
			requirements: def.requirements ?? [],
		};
		this.descriptors.set(kind, descriptor);
		return descriptor;
	}

	describeAll(): KindDescriptor[] {
		return this.list().map((def) => this.describe(def.kind));
	}

	/** Generates the input JSON Schema so defaulted fields remain optional. */
	jsonSchema(kind: string): Record<string, unknown> {
		const cached = this.descriptors.get(kind);
		if (cached) return cached.json_schema;
		return z.toJSONSchema(this.get(kind).configSchema, { io: 'input' }) as Record<string, unknown>;
	}

	secretPathsOf(kind: string): SecretPath[] {
		const cached = this.paths.get(kind);
		if (cached) return cached;
		const paths = secretPaths(this.jsonSchema(kind));
		this.paths.set(kind, paths);
		return paths;
	}
}
