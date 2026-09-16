import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { build } from 'vite-plus';
import type { BridgeHandle } from '../src/protocol';

declare global {
	interface Window {
		bridge: BridgeHandle;
		connect: () => void;
		updates: number;
		loads: number;
	}
}

async function bundle(entry: string): Promise<string> {
	const result = await build({
		configFile: false,
		logLevel: 'silent',
		build: {
			write: false,
			minify: false,
			lib: { entry: new URL(entry, import.meta.url).pathname, formats: ['es'] },
		},
	});
	const built = Array.isArray(result) ? result[0] : result;
	if (!('output' in built)) throw new Error('Unexpected watch build');
	const output = built.output;
	const chunk = output.find((item) => item.type === 'chunk');
	if (!chunk) throw new Error('Missing browser bundle');
	return chunk.code;
}

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Missing server address');
	return `http://127.0.0.1:${address.port}`;
}

export async function harness() {
	const [hostScript, notebookScript] = await Promise.all([
		bundle('../src/host.ts'),
		bundle('../src/notebook.ts'),
	]);
	let hostOrigin = '';
	const child = createServer((req, res) => {
		if (req.url === '/incompatible') {
			res.setHeader('Content-Type', 'text/html');
			res.end(
				`<script>addEventListener('message', () => parent.postMessage({namespace:'marimohub.notebook-bridge',kind:'ready',documentId:'v2-document',version:{major:2,minor:0},capabilities:['query-params.v1']}, '${hostOrigin}'));</script><p>Unsupported notebook</p>`,
			);
			return;
		}
		res.setHeader(
			'Content-Type',
			req.url === '/notebook.js' ? 'application/javascript' : 'text/html',
		);
		res.end(
			req.url === '/notebook.js'
				? notebookScript
				: `<script type="module">
   import { startNotebookBridge } from '/notebook.js';
   window.bridge = startNotebookBridge({parentOrigin: '${hostOrigin}'});
   if (new URLSearchParams(location.search).has('early')) history.replaceState({}, '', '?early=observed&access_token=private');
  </script><p>Notebook</p>`,
		);
	});
	const childOrigin = await listen(child);
	const host = createServer((req, res) => {
		res.setHeader('Content-Type', req.url === '/host.js' ? 'application/javascript' : 'text/html');
		if (req.url === '/host.js') {
			res.end(hostScript);
			return;
		}
		const params = new URL(req.url!, 'http://localhost').searchParams;
		const source = params.get('child') ?? `${childOrigin}/?early=1`;
		// Test-only fixture URLs are escaped as data, never HTML attributes.
		res.end(`<iframe id="frame" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer"></iframe>
  <script type="module">
   import { createHostBridge } from '/host.js';
   const frame = document.querySelector('iframe');
   window.updates = 0; window.loads = 0;
   frame.addEventListener('load', () => window.loads++);
   window.connect = () => { window.bridge?.dispose(); window.bridge = createHostBridge({iframe: frame, origin: ${JSON.stringify(new URL(source).origin)}, excludedKeys:['provider'], onQuery({entries}) {
    window.updates++; const query = new URLSearchParams(entries).toString();
    history.replaceState(history.state, '', location.pathname + (query ? '?' + query : '') + location.hash);
    return true;
   }}); };
   frame.src = ${JSON.stringify(source)};
   setTimeout(window.connect, ${params.get('delay') === '1' ? 500 : 0});
  </script>`);
	});
	hostOrigin = await listen(host);
	return {
		hostOrigin,
		childOrigin,
		async close() {
			await Promise.all(
				[host, child].map(
					(server) =>
						new Promise<void>((resolve, reject) => {
							server.close((error) => (error ? reject(error) : resolve()));
						}),
				),
			);
		},
	};
}
