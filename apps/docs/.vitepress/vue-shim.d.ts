// Plain `tsc` cannot resolve Vue SFC imports; type them as generic components so
// surrounding TypeScript files are still checked.
declare module '*.vue' {
	import type { DefineComponent } from 'vue';
	const component: DefineComponent;
	export default component;
}

declare module '*.css';

// VitePress does not make Vite's client globals available to this standalone tsc run.
interface ImportMeta {
	glob(
		pattern: string | string[],
		options: { eager?: boolean; import?: string; query?: string },
	): Record<string, unknown>;
}
