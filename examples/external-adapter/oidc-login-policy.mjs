// Example OIDC login-policy module. It maps validated identity-provider claims
// to a login decision (allow or deny) plus coarse marimohub entitlements.
//
// The built-in OIDC adapter completes all protocol work first: discovery, PKCE,
// state/nonce, ID-token verification, UserInfo subject binding, email
// verification, and the email-domain allowlist. This module only sees the
// validated result — claims whose *values* are still provider-controlled data,
// so guard every read.
//
// The attribute names, values, and ordering below are placeholders, not an
// authoritative classification policy. Replace them with your organization's
// claim paths and rules.

// A Map, not an object literal: claim values index into it, and an object
// lookup would resolve prototype names ('toString', 'constructor', …) to
// functions, turning the rank comparison into a NaN check that passes.
const LEVEL_RANK = new Map([
	['baseline', 0],
	['elevated', 1],
	['restricted', 2],
]);
const MINIMUM_LEVEL_RANK = LEVEL_RANK.get('elevated');

const ALLOWED_DEPARTMENTS = new Set(['orgcode1', 'orgcode2']);
const REQUIRED_ELEMENTS = ['element-a', 'element-b'];

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value) {
	return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

export default {
	apiVersion: 1,
	kind: 'oidc-login-policy',
	create(context) {
		// The factory receives the full environment record for module settings,
		// e.g. context.env.MY_ORG_LOGIN_POLICY_MODE.
		void context;
		return {
			evaluate(input) {
				// A compound AND rule across multiple claim paths: department AND
				// minimum level AND all required elements. ID-token and UserInfo
				// claims arrive as separate objects; they are never merged.
				const attributes = isRecord(input.idTokenClaims.user_attributes)
					? input.idTokenClaims.user_attributes
					: {};
				const departmentAllowed = ALLOWED_DEPARTMENTS.has(attributes.department);
				const rank =
					typeof attributes.access_level === 'string'
						? (LEVEL_RANK.get(attributes.access_level) ?? -1)
						: -1;
				const elements = stringArray(attributes.elements);
				const elementsAllowed = REQUIRED_ELEMENTS.every((element) => elements.includes(element));

				if (!departmentAllowed || rank < MINIMUM_LEVEL_RANK || !elementsAllowed) {
					// The reason is a bounded token for operator logs only; users always
					// see the same generic access-policy message.
					return { decision: 'deny', reason: 'example_access_policy' };
				}

				return {
					decision: 'allow',
					// Only the built-in entitlements are accepted: 'super-admin',
					// 'default-role:viewer', 'default-role:editor', 'default-role:manager'.
					entitlements: ['default-role:editor'],
				};
			},
		};
	},
};
