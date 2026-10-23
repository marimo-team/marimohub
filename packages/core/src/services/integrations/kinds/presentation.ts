import { z } from 'zod';
import { defineIntegration } from '../sdk';
import { textFileContent } from '../text';

export const customCss = defineIntegration({
	kind: 'custom_css',
	title: 'Custom CSS',
	description:
		'Apply CSS to marimo editors, apps, and HTML exports through marimo display configuration.',
	category: 'other',
	brand: { color: '#663399' },
	schemaVersion: 1,
	configSchema: z.strictObject({ css: textFileContent('CSS stylesheet applied to marimo pages') }),
	uiHints: {
		css: {
			widget: 'textarea',
			file_accept: ['.css'],
			placeholder: ':root { --marimo-heading-font: Georgia, serif; }',
		},
	},
	render({ config }) {
		return { presentation: { css: config.css } };
	},
});

export const htmlHead = defineIntegration({
	kind: 'html_head',
	title: 'HTML head',
	description:
		'Add HTML to app and export heads. Replaces the notebook head file; does not run in the editor.',
	category: 'other',
	brand: { color: '#E34F26' },
	schemaVersion: 1,
	configSchema: z.strictObject({
		html: textFileContent(
			'HTML head fragment, including any browser scripts; visible to app viewers',
		),
	}),
	uiHints: {
		html: {
			widget: 'textarea',
			file_accept: ['.html', '.htm'],
			placeholder: '<meta name="author" content="My team">',
		},
	},
	render({ config }) {
		return { presentation: { htmlHead: config.html } };
	},
});
