export default {
	apiVersion: 1,
	kind: 'oidc-login-policy',
	async create() {
		throw new Error('login-policy initialization rejected');
	},
};
