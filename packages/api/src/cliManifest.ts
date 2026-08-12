type JsonObject = Record<string, unknown>;

export interface CliParameter {
	name: string;
	cli_name: string;
	in: 'path' | 'query' | 'header';
	required: boolean;
	description?: string;
	value_type: string;
	repeatable: boolean;
}

export interface CliBodyProperty {
	name: string;
	cli_name: string;
	required: boolean;
	description?: string;
	value_type: string;
	repeatable: boolean;
}

export interface CliOperation {
	id: string;
	command: string[];
	method: string;
	path: string;
	summary: string;
	description?: string;
	parameters: CliParameter[];
	body?: {
		required: boolean;
		properties: CliBodyProperty[];
	};
	destructive: boolean;
	paginated: boolean;
	response_kind: 'json' | 'raw';
	session_only: boolean;
	accepts_if_match: boolean;
	accepts_idempotency_key: boolean;
	preflight_operation_id?: string;
}

export interface CliManifest {
	version: 1;
	api_version: string;
	operations: CliOperation[];
}

const HTTP_METHODS = ['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'trace'];

function object(value: unknown, context: string): JsonObject {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`Expected ${context} to be an object`);
	}
	return value as JsonObject;
}

function optionalObject(value: unknown): JsonObject | undefined {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
	return value as JsonObject;
}

function resolve(document: JsonObject, value: unknown): JsonObject {
	const candidate = object(value, 'OpenAPI reference');
	const reference = candidate.$ref;
	if (typeof reference !== 'string') return candidate;
	if (!reference.startsWith('#/')) throw new Error(`Unsupported external reference: ${reference}`);
	let current: unknown = document;
	for (const part of reference.slice(2).split('/')) {
		current = object(current, reference)[part.replaceAll('~1', '/').replaceAll('~0', '~')];
	}
	return resolve(document, current);
}

function schemaType(document: JsonObject, value: unknown): { type: string; repeatable: boolean } {
	const schema = resolve(document, value);
	if (schema.type === 'array') {
		const item = optionalObject(schema.items);
		return { type: item ? schemaType(document, item).type : 'string', repeatable: true };
	}
	if (typeof schema.type === 'string') return { type: schema.type, repeatable: false };
	if (Array.isArray(schema.type)) {
		const type = schema.type.find((item) => item !== 'null');
		if (typeof type === 'string') return { type, repeatable: false };
	}
	if (schema.properties || schema.oneOf || schema.anyOf || schema.allOf) {
		return { type: 'object', repeatable: false };
	}
	return { type: 'string', repeatable: false };
}

function cliName(name: string): string {
	return name
		.replaceAll(/([a-z\d])([A-Z])/g, '$1-$2')
		.replaceAll('_', '-')
		.toLowerCase();
}

function parametersFor(
	document: JsonObject,
	pathItem: JsonObject,
	operation: JsonObject,
): CliParameter[] {
	const values = [...(Array.isArray(pathItem.parameters) ? pathItem.parameters : [])];
	if (Array.isArray(operation.parameters)) values.push(...operation.parameters);
	return values
		.map((value) => resolve(document, value))
		.map((parameter): CliParameter => {
			const location = parameter.in;
			if (location !== 'path' && location !== 'query' && location !== 'header') {
				throw new Error(`Unsupported parameter location: ${String(location)}`);
			}
			const name = String(parameter.name);
			const type = schemaType(document, parameter.schema);
			return {
				name,
				cli_name: cliName(name),
				in: location,
				required: parameter.required === true,
				...(typeof parameter.description === 'string'
					? { description: parameter.description }
					: {}),
				value_type: type.type,
				repeatable: type.repeatable,
			};
		})
		.sort((a, b) => a.in.localeCompare(b.in) || a.name.localeCompare(b.name));
}

function bodyFor(document: JsonObject, operation: JsonObject): CliOperation['body'] {
	if (!operation.requestBody) return undefined;
	const requestBody = resolve(document, operation.requestBody);
	const content = object(requestBody.content, 'request body content');
	const media = optionalObject(content['application/json']);
	if (!media?.schema) return undefined;
	const schema = resolve(document, media.schema);
	const properties = optionalObject(schema.properties) ?? {};
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	return {
		required: requestBody.required === true,
		properties: Object.entries(properties)
			.map(([name, value]) => {
				const property = resolve(document, value);
				const type = schemaType(document, property);
				return {
					name,
					cli_name: cliName(name),
					required: required.has(name),
					...(typeof property.description === 'string'
						? { description: property.description }
						: {}),
					value_type: type.type,
					repeatable: type.repeatable,
				};
			})
			.sort((a, b) => a.name.localeCompare(b.name)),
	};
}

function successResponse(document: JsonObject, operation: JsonObject): JsonObject | undefined {
	const responses = optionalObject(operation.responses) ?? {};
	const entry = Object.entries(responses)
		.filter(([status]) => /^2\d\d$/.test(status))
		.sort(([a], [b]) => a.localeCompare(b))[0];
	return entry ? resolve(document, entry[1]) : undefined;
}

function responseKind(document: JsonObject, operation: JsonObject): 'json' | 'raw' {
	const response = successResponse(document, operation);
	const content = optionalObject(response?.content);
	return content?.['application/json'] ? 'json' : 'raw';
}

function isPaginated(document: JsonObject, operation: JsonObject): boolean {
	const response = successResponse(document, operation);
	const content = optionalObject(response?.content);
	const media = optionalObject(content?.['application/json']);
	if (!media?.schema) return false;
	const envelope = resolve(document, media.schema);
	const envelopeProperties = optionalObject(envelope.properties);
	if (!envelopeProperties?.data) return false;
	const data = resolve(document, envelopeProperties.data);
	const properties = optionalObject(data.properties);
	return Boolean(properties?.items && properties.next_cursor);
}

function isSessionOnly(operation: JsonObject): boolean {
	if (!Array.isArray(operation.security) || operation.security.length !== 1) return false;
	const requirement = optionalObject(operation.security[0]);
	return Boolean(requirement && Object.keys(requirement).length === 1 && requirement.cookieAuth);
}

export function generateCliManifest(documentValue: Record<string, unknown>): CliManifest {
	const document = documentValue;
	const paths = object(document.paths, 'OpenAPI paths');
	const operations: CliOperation[] = [];

	for (const [path, pathValue] of Object.entries(paths)) {
		const pathItem = object(pathValue, `path ${path}`);
		for (const method of HTTP_METHODS) {
			const operationValue = pathItem[method];
			if (!operationValue) continue;
			const operation = object(operationValue, `${method.toUpperCase()} ${path}`);
			if (typeof operation.operationId !== 'string') {
				throw new TypeError(`${method.toUpperCase()} ${path} has no operationId`);
			}
			const parameters = parametersFor(document, pathItem, operation);
			const body = bodyFor(document, operation);
			operations.push({
				id: operation.operationId,
				command: operation.operationId.split('.'),
				method: method.toUpperCase(),
				path,
				summary: typeof operation.summary === 'string' ? operation.summary : operation.operationId,
				...(typeof operation.description === 'string'
					? { description: operation.description }
					: {}),
				parameters,
				...(body ? { body } : {}),
				destructive: method === 'delete',
				paginated: isPaginated(document, operation),
				response_kind: responseKind(document, operation),
				session_only: isSessionOnly(operation),
				accepts_if_match: parameters.some(
					(parameter) => parameter.name.toLowerCase() === 'if-match',
				),
				accepts_idempotency_key: parameters.some(
					(parameter) => parameter.name.toLowerCase() === 'idempotency-key',
				),
			});
		}
	}

	operations.sort((a, b) => a.id.localeCompare(b.id));
	const getByPath = new Map(
		operations
			.filter((operation) => operation.method === 'GET')
			.map((operation) => [operation.path, operation]),
	);
	for (const operation of operations) {
		if (!operation.accepts_if_match) continue;
		const preflight = getByPath.get(operation.path);
		if (preflight) operation.preflight_operation_id = preflight.id;
	}

	const info = object(document.info, 'OpenAPI info');
	return {
		version: 1,
		api_version: String(info.version),
		operations,
	};
}
