import type { Plugin } from 'vite';

export function rejectChunkCycles(): Plugin {
	return {
		name: 'reject-chunk-cycles',
		apply: 'build',
		generateBundle(_, bundle) {
			const visited = new Set<string>();
			const active = new Set<string>();
			const path: string[] = [];
			const visit = (name: string) => {
				if (active.has(name)) {
					this.error(
						`Static chunk import cycle: ${[...path.slice(path.indexOf(name)), name].join(' -> ')}`,
					);
				}
				if (visited.has(name)) return;
				const chunk = bundle[name];
				if (chunk?.type !== 'chunk') return;
				visited.add(name);
				active.add(name);
				path.push(name);
				// Dynamic imports do not impose module initialization order.
				for (const dependency of chunk.imports) visit(dependency);
				path.pop();
				active.delete(name);
			};
			for (const name of Object.keys(bundle)) visit(name);
		},
	};
}
