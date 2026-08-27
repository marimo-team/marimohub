export function sandbox(invalidCapability) {
	const instance = {
		async exec() {
			return { success: true, stdout: '', stderr: '' };
		},
		async execStream() {
			return new ReadableStream();
		},
		async readFile() {
			return { success: false, content: '', error: { code: 'NOT_FOUND' } };
		},
		async listFiles() {
			return { success: true, files: [] };
		},
		async writeFiles() {},
		async gitCheckout() {},
		async setEnvVars() {},
		async mountBucket() {},
		async unmountBucket() {},
		async startProcess() {
			return {
				id: 'fixture',
				command: '',
				async kill() {},
				async waitForPort() {},
				async getLogs() {
					return { stdout: '', stderr: '' };
				},
			};
		},
		async exposePort() {
			return { url: 'https://example.test' };
		},
		async destroy() {},
	};
	if (invalidCapability) instance[invalidCapability] = 'invalid';
	return instance;
}

export default {
	apiVersion: 1,
	kind: 'compute',
	create(context) {
		return {
			factoryContext: context,
			create() {
				return sandbox(context.env.MARIMOHUB_COMPUTE_LIBRARY_INVALID_CAPABILITY);
			},
			async proxy() {
				return null;
			},
		};
	},
};
