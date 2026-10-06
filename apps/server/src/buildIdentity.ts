export function buildIdentity(env: Record<string, string | undefined> = process.env) {
	return {
		'service.version': env.MARIMOHUB_VERSION ?? 'dev',
		...(env.MARIMOHUB_GIT_SHA ? { 'vcs.ref.head.revision': env.MARIMOHUB_GIT_SHA } : {}),
	};
}
