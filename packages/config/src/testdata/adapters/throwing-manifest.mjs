const manifest = {
	kind: 'storage',
	create() {},
};

Object.defineProperty(manifest, 'apiVersion', {
	get() {
		throw new Error('manifest getter failed');
	},
});

export default manifest;
