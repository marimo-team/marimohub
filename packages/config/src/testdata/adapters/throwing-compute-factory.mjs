export default {
	apiVersion: 1,
	kind: 'compute',
	async create() {
		throw new Error('compute initialization rejected');
	},
};
