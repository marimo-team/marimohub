export default {
	apiVersion: 1,
	kind: 'oidc-login-policy',
	create() {
		return { evaluate: 'not-a-function' };
	},
};
