import { execFileSync } from 'node:child_process';
import type { GitFetch } from '../transport';

// Isolate fixtures from the developer's global and system Git config (signing, hooks, aliases).
const GIT_ENV = {
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_AUTHOR_NAME: 'Test Author',
	GIT_AUTHOR_EMAIL: 'author@example.com',
	GIT_COMMITTER_NAME: 'Test Committer',
	GIT_COMMITTER_EMAIL: 'committer@example.com',
};

export function gitBytes(cwd: string, args: string[], input?: string | Uint8Array): Buffer {
	return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
		cwd,
		input,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, ...GIT_ENV },
	});
}

export function git(cwd: string, args: string[], input?: string | Uint8Array): string {
	return gitBytes(cwd, args, input).toString('utf8').trim();
}

function packetLine(text: string): Buffer {
	return Buffer.from(`${(Buffer.byteLength(text) + 4).toString(16).padStart(4, '0')}${text}`);
}

const SERVICES = new Set(['git-upload-pack', 'git-receive-pack']);

export async function smartHttpResponse(
	repository: string,
	url: string,
	init: RequestInit = {},
	services: readonly string[] = ['git-upload-pack'],
): Promise<Response> {
	const target = new URL(url);
	const method = init.method ?? 'GET';
	if (target.pathname.endsWith('/info/refs') && method === 'GET') {
		const service = target.searchParams.get('service') ?? '';
		if (!SERVICES.has(service) || !services.includes(service))
			throw new Error(`Unexpected Git service ${service}`);
		const advertised = gitBytes(repository, [
			service.slice(4),
			'--stateless-rpc',
			'--advertise-refs',
			repository,
		]);
		return new Response(
			new Uint8Array(
				Buffer.concat([packetLine(`# service=${service}\n`), Buffer.from('0000'), advertised]),
			),
			{ headers: { 'content-type': `application/x-${service}-advertisement` } },
		);
	}
	const service = target.pathname.split('/').at(-1) ?? '';
	if (method !== 'POST' || !SERVICES.has(service) || !services.includes(service))
		throw new Error(`Unexpected Git request ${method} ${target.pathname}`);
	const body = init.body ? new Uint8Array(await new Response(init.body).arrayBuffer()) : undefined;
	const result = gitBytes(repository, [service.slice(4), '--stateless-rpc', repository], body);
	return new Response(new Uint8Array(result), {
		headers: { 'content-type': `application/x-${service}-result` },
	});
}

export function uploadPackFetcher(repository: string): GitFetch {
	return (url, init) => smartHttpResponse(repository, url, init);
}
