export default {
	apiVersion: 1,
	kind: 'subject-security-context',
	create(context) {
		return {
			factoryContext: context,
			async resolve(principal) {
				if (principal.credential.kind !== 'sso') return null;
				return {
					schemaVersion: 1,
					classification: 'SECRET',
					compartments: ['element-a'],
					policyVersion: 'fixture-1',
					expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
				};
			},
		};
	},
};
