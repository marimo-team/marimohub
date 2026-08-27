export default {
	apiVersion: 1,
	kind: 'storage',
	create() {
		return Object.defineProperty({}, 'get', {
			get() {
				throw new Error('shape getter failed');
			},
		});
	},
};
