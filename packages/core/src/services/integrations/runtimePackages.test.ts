import { describe, expect, it } from 'vitest';
import { mergeRuntimePackages } from './runtimePackages';

describe('runtime packages', () => {
	it('combines extras for the same pinned distribution in a stable order', () => {
		expect(
			mergeRuntimePackages([
				'marimo_studio[typst]==0.4.1',
				'marimo-studio[deno]==0.4.1',
				'Marimo.Studio==0.4.1',
			]),
		).toEqual(['marimo-studio[deno,typst]==0.4.1']);
	});
	it('rejects conflicting versions across normalized distribution aliases', () => {
		expect(() => mergeRuntimePackages(['Marimo_Studio==0.4.1', 'marimo.studio==0.4.2'])).toThrow(
			'different versions',
		);
	});
	it.each([
		'--index-url=x',
		'studio',
		'studio>=0.4.1',
		'./studio',
		'studio @ https://example.com/studio.whl',
		'studio==0.4.1\n',
		'studio[,deno]==0.4.1',
		'studio[deno,]==0.4.1',
		'studio[deno,,typst]==0.4.1',
		'studio==0.4.1; python_version > "3.11"',
		'studio==0.4.1 && touch /tmp/injected',
		'studio==0.4.1$(id)',
		'studio==0.4.1\r\n',
		'marimo==0.25.2',
		'MARIMO[recommended]==0.25.2',
	])('rejects unsupported requirement %s', (requirement) => {
		expect(() => mergeRuntimePackages([requirement])).toThrow();
	});
	it('deduplicates extras and sorts distributions regardless of integration order', () => {
		const requirements = [
			'z-tool==1.0.0',
			'Marimo_Studio[DENO,some_extra]==0.4.1',
			'marimo-studio[deno,some-extra]==0.4.1',
		];
		const expected = ['marimo-studio[deno,some-extra]==0.4.1', 'z-tool==1.0.0'];
		expect(mergeRuntimePackages(requirements)).toEqual(expected);
		expect(mergeRuntimePackages([...requirements].reverse())).toEqual(expected);
	});
});
