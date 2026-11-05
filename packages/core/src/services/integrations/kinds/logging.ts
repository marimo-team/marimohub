import { z } from 'zod';
import { ValidationError } from '../../../errors';
import type { LoggingDestination } from '../../../ports/integrations';
import { LOGGING_PACKAGES } from '../../runtime/logging';
import { basicAuthHeader, defineIntegration } from '../sdk';
import type { RenderInput, RenderOutput } from '../sdk';
import { zSecret } from '../secretFields';
import { HTTP_HEADER_NAME_REGEX, serviceUrlField } from './common';

const common = {
	level: z.enum(['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']).default('INFO'),
	service_name: z.string().min(1).max(128).default('marimohub-notebook'),
};
const url = serviceUrlField().describe('Full OTLP/HTTP logs URL, including /v1/logs');
const headers = z
	.array(
		z.strictObject({
			name: z.string().regex(HTTP_HEADER_NAME_REGEX),
			value: zSecret(),
		}),
	)
	.max(32)
	.refine(
		(items) => new Set(items.map(({ name }) => name.toLowerCase())).size === items.length,
		'Duplicate header name (case insensitive)',
	)
	.meta({ 'x-unique-by': 'name' })
	.default([]);

function renderLogging(
	input: RenderInput<z.infer<z.ZodObject<typeof common>> & { url: string }>,
	headers: Record<string, string>,
): RenderOutput {
	if (!url.safeParse(input.config.url).success) throw new ValidationError('Invalid OTLP logs URL.');
	for (const [name, value] of Object.entries(headers)) {
		if (
			!HTTP_HEADER_NAME_REGEX.test(name) ||
			/[^\x20-\x7e]/.test(value) ||
			/^(host|content-length|content-type|connection|transfer-encoding)$/i.test(name)
		) {
			throw new ValidationError('Invalid OTLP authentication header.');
		}
	}
	const destination: LoggingDestination = {
		name: input.instanceName,
		url: input.config.url,
		headers,
		level: input.config.level,
		serviceName: input.config.service_name,
		attributes: {
			'marimohub.project_id': input.projectId,
			'marimohub.workload_kind': input.workload.kind,
			'marimohub.workload_id': input.workload.id,
		},
	};
	return { logging: [destination], runtimePackages: [...LOGGING_PACKAGES] };
}

export const otlpLogs = defineIntegration({
	kind: 'otlp_logs',
	title: 'OpenTelemetry logs',
	description: 'Export notebook Python logging and marimo logs to an OTLP/HTTP endpoint.',
	category: 'other',
	brand: { color: '#F5A800' },
	schemaVersion: 1,
	configSchema: z.strictObject({ url, headers, ...common }),
	uiHints: { 'headers.*.value': { widget: 'password' } },
	render(input) {
		return renderLogging(
			input,
			Object.fromEntries(input.config.headers.map(({ name, value }) => [name, value])),
		);
	},
});

export const grafanaCloudLogs = defineIntegration({
	kind: 'grafana_cloud_logs',
	title: 'Grafana Cloud logs',
	description: 'Export notebook Python logging and marimo logs to Grafana Cloud using OTLP/HTTP.',
	category: 'other',
	brand: { color: '#F46800' },
	schemaVersion: 1,
	configSchema: z.strictObject({
		url,
		username: z
			.string()
			.min(1)
			.max(256)
			.regex(/^[^:\s]+$/)
			.describe('Grafana Cloud OTLP instance ID'),
		token: zSecret().describe('Access policy token with permission to write logs'),
		...common,
	}),
	uiHints: { token: { widget: 'password' } },
	render(input) {
		return renderLogging(input, {
			Authorization: basicAuthHeader(input.config.username, input.config.token),
		});
	},
});

export const betterStackLogs = defineIntegration({
	kind: 'better_stack_logs',
	title: 'Better Stack logs',
	description: 'Export notebook Python logging and marimo logs to Better Stack using OTLP/HTTP.',
	category: 'other',
	brand: { color: '#6366F1' },
	schemaVersion: 1,
	configSchema: z.strictObject({ url, source_token: zSecret(), ...common }),
	uiHints: { source_token: { widget: 'password' } },
	render(input) {
		return renderLogging(input, {
			Authorization: `Bearer ${input.config.source_token}`,
		});
	},
});
