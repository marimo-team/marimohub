export default {
	apiVersion: 1,
	kind: 'oidc-login-policy',
	async create() {
		await Promise.resolve();
		return { evaluate: async () => ({ decision: 'allow' }) };
	},
};
