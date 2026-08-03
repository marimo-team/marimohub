import { z } from 'zod';
import { ValidationError } from '../../errors';
import { logOperationalError } from '../../operationalLog';
import type { KindDescriptor } from '../../ports/integrations';
import type { IntegrationDefinition } from './sdk';
import { secretPaths } from './secretFields';
import type { SecretPath } from './secretFields';

const KIND_REGEX = /^[a-z][a-z0-9_]{1,31}$/;

export class IntegrationRegistry {
	private readonly defs = new Map<string, IntegrationDefinition>();
	private readonly descriptors = new Map<string, KindDescriptor>();
	private readonly inputSchemas = new Map<string, Record<string, unknown>>();
	private readonly storedSchemas = new Map<string, Record<string, unknown>>();
	private readonly paths = new Map<string, SecretPath[]>();

	register(def: IntegrationDefinition): void {
		if (!KIND_REGEX.test(def.kind)) {
			throw new Error(`Invalid integration kind "${def.kind}": must match ${KIND_REGEX}`);
		}
		if (this.defs.has(def.kind)) {
			throw new Error(`Duplicate integration kind "${def.kind}"`);
		}
		let inputSchema: Record<string, unknown>;
		let storedSchema: Record<string, unknown>;
		let paths: SecretPath[];
		try {
			inputSchema = decorateJsonSchema(
				z.toJSONSchema(def.configSchema, { io: 'input' }) as Record<string, unknown>,
			);
			storedSchema = decorateJsonSchema(
				z.toJSONSchema(def.configSchema, { io: 'output' }) as Record<string, unknown>,
				true,
			);
			paths = secretPaths(inputSchema);
		} catch (err) {
			logOperationalError(
				'integration_kind_disabled',
				{ operation: 'integration.registry.register', integration_kind: def.kind },
				err,
			);
			return;
		}
		this.defs.set(def.kind, def);
		this.inputSchemas.set(def.kind, inputSchema);
		this.storedSchemas.set(def.kind, storedSchema);
		this.paths.set(def.kind, paths);
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

	/** Generates the strict authoring schema; defaulted fields remain optional. */
	jsonSchema(kind: string): Record<string, unknown> {
		this.get(kind);
		return this.inputSchemas.get(kind)!;
	}

	/** Generates the persisted shape: defaults materialized and secrets sealed. */
	storedJsonSchema(kind: string): Record<string, unknown> {
		this.get(kind);
		return this.storedSchemas.get(kind)!;
	}

	secretPathsOf(kind: string): SecretPath[] {
		const cached = this.paths.get(kind);
		if (cached) return cached;
		const paths = secretPaths(this.jsonSchema(kind));
		this.paths.set(kind, paths);
		return paths;
	}
}

const MANAGED_STORED_SECRET = {
	type: 'object',
	properties: {
		$secret: {
			type: 'object',
			properties: {
				kind: { const: 'managed', type: 'string' },
				envelope: {
					type: 'object',
					properties: {
						kek_id: { type: 'string', minLength: 1 },
						alg: { const: 'A256GCM', type: 'string' },
						iv: { type: 'string', minLength: 1 },
						ciphertext: { type: 'string', minLength: 1 },
					},
					required: ['kek_id', 'alg', 'iv', 'ciphertext'],
					additionalProperties: false,
				},
			},
			required: ['kind', 'envelope'],
			additionalProperties: false,
		},
	},
	required: ['$secret'],
	additionalProperties: false,
};

const REFERENCE_STORED_SECRET = {
	type: 'object',
	properties: {
		$secret: {
			type: 'object',
			properties: {
				kind: { const: 'reference', type: 'string' },
				backend: { type: 'string', minLength: 1 },
				locator: { type: 'string', minLength: 1 },
			},
			required: ['kind', 'backend', 'locator'],
			additionalProperties: false,
		},
	},
	required: ['$secret'],
	additionalProperties: false,
};

export const INTEGRATION_STORED_SECRET_SCHEMAS = {
	ManagedStoredSecret: MANAGED_STORED_SECRET,
	ReferenceStoredSecret: REFERENCE_STORED_SECRET,
};

function decorateJsonSchema(
	schema: Record<string, unknown>,
	stored = false,
): Record<string, unknown> {
	const visit = (node: unknown): void => {
		if (typeof node !== 'object' || node === null) return;
		const record = node as Record<string, unknown>;
		if (record['x-marimohub-secret'] === true) {
			if (stored) {
				const description = record.description;
				for (const key of Object.keys(record)) delete record[key];
				Object.assign(record, {
					oneOf: [
						{ $ref: '#/components/schemas/ManagedStoredSecret' },
						{ $ref: '#/components/schemas/ReferenceStoredSecret' },
					],
					'x-marimohub-secret': true,
					...(description === undefined ? {} : { description }),
				});
			} else {
				record.writeOnly = true;
			}
			return;
		}

		const union = (record.oneOf ?? record.anyOf) as Record<string, unknown>[] | undefined;
		if (Array.isArray(union) && union.length > 0) {
			const discriminator = discriminatorOf(union);
			if (discriminator) record.discriminator = { propertyName: discriminator };
		}
		for (const value of Object.values(record)) {
			if (Array.isArray(value)) value.forEach(visit);
			else visit(value);
		}
	};
	visit(schema);
	return schema;
}

function discriminatorOf(branches: Record<string, unknown>[]): string | undefined {
	let common: Set<string> | undefined;
	for (const branch of branches) {
		const properties = branch.properties as Record<string, Record<string, unknown>> | undefined;
		if (!properties) return undefined;
		const constants = new Set(
			Object.entries(properties)
				.filter(([, value]) => typeof value.const === 'string')
				.map(([key]) => key),
		);
		common =
			common === undefined ? constants : new Set([...common].filter((key) => constants.has(key)));
	}
	return common?.size === 1 ? [...common][0] : undefined;
}
