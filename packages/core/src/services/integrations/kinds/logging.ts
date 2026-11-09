import { z } from 'zod';
import { ValidationError } from '../../../errors';
import type { LoggingDestination } from '../../../ports/integrations';
import { basicAuthHeader, defineIntegration, probeEndpoint } from '../sdk';
import { zSecret } from '../secretFields';
import {
	HTTP_HEADER_NAME_REGEX,
	isInsecureHttpUrl,
	secretHeadersField,
	serviceUrlField,
} from './common';

const url = serviceUrlField().describe('Full OTLP/HTTP JSON logs URL, including /v1/logs').meta({
	'x-marimohub-refinement':
		'A valid http(s) logs URL with an authority, no userinfo, query, fragment, or port 0',
});

const authSchema = z
	.discriminatedUnion('method', [
		z.strictObject({ method: z.literal('none') }),
		z.strictObject({
			method: z.literal('bearer'),
			token: zSecret().describe('Token sent as `Authorization: Bearer <token>`'),
		}),
		z.strictObject({
			method: z.literal('basic'),
			username: z
				.string()
				.min(1)
				.max(256)
				.regex(/^[^:\s]+$/)
				.describe('Basic-auth username'),
			password: zSecret().describe('Basic-auth password or token'),
		}),
		z.strictObject({
			method: z.literal('headers'),
			headers: secretHeadersField()
				.min(1)
				.describe('HTTP headers sent with every export request, such as an API key or tenant ID'),
		}),
	])
	.default({ method: 'none' })
	.describe('How export requests authenticate');
type Auth = z.infer<typeof authSchema>;

// The exporter sets these itself; a configured value would corrupt the request.
const RESERVED_HEADER_REGEX = /^(host|content-length|content-type|connection|transfer-encoding)$/i;

function authHeaders(auth: Auth): Record<string, string> {
	switch (auth.method) {
		case 'none':
			return {};
		case 'bearer':
			return { Authorization: `Bearer ${auth.token}` };
		case 'basic':
			return { Authorization: basicAuthHeader(auth.username, auth.password) };
		case 'headers':
			return Object.fromEntries(auth.headers.map(({ name, value }) => [name, value]));
	}
}

// A name that cannot match a Python logger would silently export nothing.
const LOGGER_NAME_REGEX = /^[^.\s]+(?:\.[^.\s]+)*$/;

// Header values are only known after secret resolution, so they are checked here as well as
// at save time.
function validateEndpoint(endpoint: string, headers: Record<string, string>): void {
	if (!url.safeParse(endpoint).success) throw new ValidationError('Invalid OTLP logs URL.');
	for (const [name, value] of Object.entries(headers)) {
		if (
			!HTTP_HEADER_NAME_REGEX.test(name) ||
			/[^\x20-\x7e]/.test(value) ||
			RESERVED_HEADER_REGEX.test(name)
		) {
			throw new ValidationError('Invalid OTLP authentication header.');
		}
	}
}

export const otlpLogs = defineIntegration({
	kind: 'otlp_logs',
	title: 'OpenTelemetry logs',
	description: 'Export notebook Python logging and marimo logs to an OTLP/HTTP JSON endpoint.',
	category: 'other',
	brand: { color: '#F5A800' },
	schemaVersion: 1,
	configSchema: z.strictObject({
		url,
		auth: authSchema,
		level: z
			.enum(['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'])
			.default('INFO')
			.describe('Lowest Python log level to export'),
		logger_names: z
			.array(
				z.strictObject({
					name: z
						.string()
						.min(1)
						.max(256)
						.regex(LOGGER_NAME_REGEX)
						.describe(
							'Logger name, including its dotted descendants. Up to 256 characters, with no whitespace or empty dot-separated parts.',
						),
				}),
			)
			.max(32)
			.refine((items) => new Set(items.map(({ name }) => name)).size === items.length, {
				message: 'Duplicate logger name',
			})
			.meta({ 'x-unique-by': 'name' })
			.optional()
			.describe(
				'Export only these logger namespaces, up to 32 unique names. Leave empty to export all eligible loggers.',
			),
		service_name: z
			.string()
			.min(1)
			.max(128)
			.default('marimohub-notebook')
			.describe('OpenTelemetry `service.name` resource attribute'),
	}),
	uiHints: {
		auth: { group: 'Authentication', order: 10 },
		'auth.token': { widget: 'password' },
		'auth.password': { widget: 'password' },
		'auth.headers.*.value': { widget: 'password' },
	},
	// Header names are not secret, so a reserved one is rejected at save time rather than
	// at render, where one bad org integration would block every notebook launch.
	validate(config) {
		if (config.auth.method === 'headers') {
			for (const { name } of config.auth.headers) {
				if (RESERVED_HEADER_REGEX.test(name)) {
					throw new ValidationError(`HTTP header "${name}" is reserved.`);
				}
			}
		}
		// Plain HTTP stays available for unauthenticated collectors on a trusted network.
		if (config.auth.method !== 'none' && isInsecureHttpUrl(config.url)) {
			throw new ValidationError('Log export with credentials requires HTTPS.');
		}
	},
	testConnection(config, probe, options) {
		const headers = authHeaders(config.auth);
		validateEndpoint(config.url, headers);
		return probeEndpoint({
			probe,
			url: config.url,
			init: {
				method: 'POST',
				headers: { ...headers, 'Content-Type': 'application/json' },
				body: JSON.stringify({ resourceLogs: [] }),
				signal: options?.signal,
			},
			carriesSecrets: true,
			describe: () => 'Endpoint accepted an empty OTLP logs request; no log records were sent.',
		});
	},
	render(input) {
		const headers = authHeaders(input.config.auth);
		validateEndpoint(input.config.url, headers);
		const destination: LoggingDestination = {
			name: input.instanceName,
			url: input.config.url,
			headers,
			level: input.config.level,
			serviceName: input.config.service_name,
			loggerNames: input.config.logger_names?.map(({ name }) => name),
			attributes: {
				'marimohub.project_id': input.projectId,
				'marimohub.workload_kind': input.workload.kind,
				'marimohub.workload_id': input.workload.id,
			},
		};
		return { logging: [destination] };
	},
});
