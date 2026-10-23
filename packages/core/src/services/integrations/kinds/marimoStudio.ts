import { z } from 'zod';
import { defineIntegration } from '../sdk';

export const marimoStudio = defineIntegration({
	kind: 'marimo_studio',
	title: 'marimo Studio (experimental)',
	description:
		'Add Studio reports, apps, and presentations to notebook sessions. Restart sessions after changes. Saved views remain when disabled.',
	category: 'other',
	brand: { color: '#14B8A6' },
	schemaVersion: 1,
	configSchema: z.strictObject({
		version: z
			.string()
			.regex(/^\d+\.\d+\.\d+$/)
			.max(32)
			.refine((value) => value.trim() === value)
			.default('0.4.1')
			.meta({
				description: 'Exact Studio version. It must support the sandbox image’s marimo version.',
			}),
		deno: z.boolean().default(true).meta({
			description: 'Include Deno for React, Svelte, Reveal.js, and Notebook Kit views.',
		}),
		typst: z.boolean().default(false).meta({ description: 'Include Typst for report views.' }),
	}),
	uiHints: {
		deno: { order: 1 },
		typst: { order: 2 },
		version: {
			order: 3,
			advanced: true,
			group: 'Compatibility',
			docs_url: 'https://marimo-team.github.io/marimo-studio/reference/compatibility',
		},
	},
	render({ config }) {
		const extras = [config.deno ? 'deno' : '', config.typst ? 'typst' : ''].filter(Boolean);
		const suffix = extras.length > 0 ? `[${extras.join(',')}]` : '';
		return {
			workspaceLoadMode: 'copy-only',
			runtimePackages: [`marimo-studio${suffix}==${config.version}`],
		};
	},
});
