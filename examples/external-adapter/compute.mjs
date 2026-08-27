const unsupported = () => Promise.reject(new Error('Replace this example with a real sandbox SDK'));

function exampleSandbox() {
	return {
		exec: unsupported,
		execStream: unsupported,
		readFile: unsupported,
		listFiles: unsupported,
		writeFiles: unsupported,
		gitCheckout: unsupported,
		setEnvVars: unsupported,
		mountBucket: unsupported,
		unmountBucket: unsupported,
		startProcess: unsupported,
		exposePort: unsupported,
		destroy: unsupported,
	};
}

export default {
	apiVersion: 1,
	kind: 'compute',
	create(context) {
		console.log('External compute adapter initialized', context.compute);
		return {
			create() {
				return exampleSandbox();
			},
			async proxy() {
				return null;
			},
		};
	},
};
