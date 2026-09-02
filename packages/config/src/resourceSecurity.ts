/**
 * Resource-security wiring: the local constraint adapter over a configured
 * classification order, plus an optional external subject-context provider.
 * Unset = no resource security — projects and notebooks that somehow carry
 * labels then fail closed in the authorization service, never open up.
 */
import { LocalResourceConstraintPolicy } from '@marimo-hub/core';
import type { ResourceSecurityPolicy } from '@marimo-hub/core';
import { parseEnum, parseList } from './env';
import type { Env } from './env';
import { ConfigError } from './errors';
import type { LoadedAdapterLibraries } from './library';

const SUBJECT_CONTEXT_VARS = [
	'MARIMOHUB_AUTHZ_SUBJECT_CONTEXT_BACKEND',
	'MARIMOHUB_AUTHZ_SUBJECT_CONTEXT_LIBRARY',
] as const;

/** True when the external subject-context library backend is selected (`none` = unset). */
export function subjectContextBackendSelected(env: Env): boolean {
	return (
		parseEnum(env, 'MARIMOHUB_AUTHZ_SUBJECT_CONTEXT_BACKEND', {
			allowed: ['library'],
			offValues: ['none'],
			remediation:
				'Set it to library, or none (or unset) to run without a subject-context provider.',
			docs: 'docs/configuration.md#server--api',
		}) === 'library'
	);
}

/**
 * Pure-env validation of the whole resource-security configuration, shared by
 * the adapter-library loader and {@link makeResourceSecurity}. The loader runs
 * it BEFORE selecting or importing a provider module: invalid configuration
 * must never execute adapter code.
 */
export function validateResourceSecurityEnv(env: Env): {
	order: string[] | undefined;
	subjectContextSelected: boolean;
} {
	const order = parseList(env.MARIMOHUB_AUTHZ_CLASSIFICATION_ORDER);
	if (order === undefined && env.MARIMOHUB_AUTHZ_CLASSIFICATION_ORDER?.trim()) {
		// Set but empty is a broken configuration, not a disable: refusing here
		// beats silently running without resource security.
		throw new ConfigError(
			'MARIMOHUB_AUTHZ_CLASSIFICATION_ORDER is set but lists no classifications.',
			{
				variable: 'MARIMOHUB_AUTHZ_CLASSIFICATION_ORDER',
				remediation:
					'List distinct classification tokens from lowest to highest, or unset the variable.',
			},
		);
	}
	if (order === undefined) {
		// Subject-context configuration without a classification order is copied
		// or stale config; fail closed instead of silently ignoring it.
		const orphaned = SUBJECT_CONTEXT_VARS.find((key) =>
			key === 'MARIMOHUB_AUTHZ_SUBJECT_CONTEXT_BACKEND'
				? subjectContextBackendSelected(env)
				: env[key]?.trim(),
		);
		if (orphaned) {
			throw new ConfigError(
				`${orphaned} requires MARIMOHUB_AUTHZ_CLASSIFICATION_ORDER — a subject-context ` +
					'provider without a constraint evaluator can never be consulted.',
				{ variable: orphaned, docs: 'docs/configuration.md#server--api' },
			);
		}
		return { order: undefined, subjectContextSelected: false };
	}

	try {
		new LocalResourceConstraintPolicy({ classificationOrder: order });
	} catch (error) {
		throw new ConfigError(
			`Invalid MARIMOHUB_AUTHZ_CLASSIFICATION_ORDER: ${error instanceof Error ? error.message : String(error)}`,
			{
				variable: 'MARIMOHUB_AUTHZ_CLASSIFICATION_ORDER',
				remediation:
					'List distinct bounded classification tokens from lowest to highest, for example "PUBLIC,INTERNAL,CONFIDENTIAL,RESTRICTED".',
			},
		);
	}

	const subjectContextSelected = subjectContextBackendSelected(env);
	if (!subjectContextSelected && env.MARIMOHUB_AUTHZ_SUBJECT_CONTEXT_LIBRARY?.trim()) {
		throw new ConfigError(
			'MARIMOHUB_AUTHZ_SUBJECT_CONTEXT_LIBRARY is set without ' +
				'MARIMOHUB_AUTHZ_SUBJECT_CONTEXT_BACKEND=library; refusing to silently ignore a ' +
				'configured provider.',
			{
				variable: 'MARIMOHUB_AUTHZ_SUBJECT_CONTEXT_LIBRARY',
				remediation: 'Set MARIMOHUB_AUTHZ_SUBJECT_CONTEXT_BACKEND=library, or unset the path.',
				docs: 'docs/configuration.md#server--api',
			},
		);
	}
	return { order, subjectContextSelected };
}

export function makeResourceSecurity(
	env: Env,
	libraries?: LoadedAdapterLibraries,
): ResourceSecurityPolicy | undefined {
	const { order, subjectContextSelected } = validateResourceSecurityEnv(env);
	if (order === undefined) return undefined;
	const constraints = new LocalResourceConstraintPolicy({ classificationOrder: order });
	if (subjectContextSelected && !libraries?.subjectContext) {
		throw new ConfigError(
			'MARIMOHUB_AUTHZ_SUBJECT_CONTEXT_BACKEND=library requires the preloaded provider; ' +
				'compose with createFromEnvAsync() (or pass a loaded instance).',
			{
				variable: 'MARIMOHUB_AUTHZ_SUBJECT_CONTEXT_BACKEND',
				docs: 'docs/configuration.md#server--api',
			},
		);
	}
	return {
		constraints,
		// Attached only under the explicit `library` selection: a preloaded
		// provider passed without it must not be silently wired in.
		...(subjectContextSelected && libraries?.subjectContext
			? { subjectContext: libraries.subjectContext }
			: {}),
	};
}
