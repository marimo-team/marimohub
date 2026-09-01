export default {
	apiVersion: 1,
	kind: 'oidc-login-policy',
	create(context) {
		return {
			factoryContext: context,
			evaluate(input) {
				const groups = Array.isArray(input.idTokenClaims.groups) ? input.idTokenClaims.groups : [];
				return groups.includes('hub-users')
					? { decision: 'allow', entitlements: ['default-role:editor'] }
					: { decision: 'deny', reason: 'fixture_policy' };
			},
		};
	},
};
