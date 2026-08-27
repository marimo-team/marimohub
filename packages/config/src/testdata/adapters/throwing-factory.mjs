export default {
	apiVersion: 1,
	kind: 'storage',
	create() {
		throw new Error('fixture initialization failed');
	},
};
