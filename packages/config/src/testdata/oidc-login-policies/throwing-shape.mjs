export default {
	apiVersion: 1,
	kind: 'oidc-login-policy',
	create() {
		return {
			get evaluate() {
				throw new Error('shape getter failed');
			},
		};
	},
};
