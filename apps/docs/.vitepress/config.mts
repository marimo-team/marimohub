import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';
import llmstxt from 'vitepress-plugin-llms';

const REPO = 'https://github.com/marimo-team/marimohub';
const SITE = 'https://marimohub.docs.marimo.io';
const OPENAPI_PATH = fileURLToPath(new URL('../../../packages/api/openapi.yaml', import.meta.url));

const openApiArtifact = {
	name: 'marimohub-openapi-artifact',
	apply: 'build' as const,
	generateBundle() {
		this.emitFile({
			type: 'asset',
			fileName: 'openapi.yaml',
			source: readFileSync(OPENAPI_PATH, 'utf8'),
		});
	},
};

// Content lives in the repo-root docs/ folder; this package is just the site tooling.
export default defineConfig({
	title: 'marimohub',
	description:
		'Self-hostable, provider-agnostic platform for storing and running marimo notebooks.',
	srcDir: '../../docs',
	cleanUrls: true,
	lastUpdated: true,
	sitemap: { hostname: SITE },

	vite: {
		plugins: [
			openApiArtifact,
			// Emits llms.txt, llms-full.txt, and a raw-markdown twin next to every page.
			llmstxt({
				domain: SITE,
				// Keep the home page twin (it has real content below the hero), but drop
				// it from llms.txt where its missing h1 would list it as "Untitled".
				excludeIndexPage: false,
				ignoreFilesPerOutput: { llmsTxt: ['index.md'] },
				// Mirrors srcExclude: setup/** are partials @include-d into the port pages.
				ignoreFiles: ['README.md', 'setup/**'],
			}),
		],
	},

	head: [
		['link', { rel: 'icon', type: 'image/png', href: '/marimo-logo.png' }],
		['meta', { name: 'theme-color', content: '#14b8a6' }],
		['meta', { property: 'og:title', content: 'marimohub' }],
		[
			'meta',
			{
				property: 'og:description',
				content: 'Self-hostable, provider-agnostic platform for marimo notebooks.',
			},
		],
		[
			'script',
			{
				async: 'true',
				src: 'https://widget.kapa.ai/kapa-widget.bundle.js',
				'data-website-id': 'a8d33c2e-7970-4f77-a09b-ea606a0f41c7',
				'data-project-name': 'marimohub',
				'data-project-color': '#0d9488',
				'data-project-logo': '/marimo-logo.png',
				// Follow the site's dark-mode toggle (VitePress sets .dark on <html>).
				'data-color-scheme-selector': '.dark',
				'data-font-family': "'Inter', ui-sans-serif, system-ui, sans-serif",
				// Match --vp-c-bg / --vp-c-bg-soft so the modal blends with the site.
				'data-surface-color-dark': '#1b1b1f',
				'data-surface-elevated-color-dark': '#202127',
				'data-example-questions':
					'How do I deploy marimohub with Helm?,What storage backends are supported?,How do I configure authentication?,How do sandboxes run notebooks?',
				'data-chat-disclaimer':
					'Answers are AI-generated from the [marimohub docs](https://marimohub.docs.marimo.io) and may contain mistakes — verify anything important.',
				'data-kapa-branding-hidden': 'true',
			},
		],
	],

	// README.md is the GitHub folder index; index.md is the site home.
	// setup/** are body-only partials pulled into the port pages via @include and
	// rendered in the wizard — not standalone pages.
	srcExclude: ['README.md', 'setup/**'],
	rewrites: {
		'deploying/README.md': 'deploying/index.md',
	},

	themeConfig: {
		nav: [
			{
				text: 'Start',
				link: '/getting-started',
				activeMatch: '^/(getting-started|deployment-options|testing-locally)',
			},
			{
				text: 'Configure',
				activeMatch:
					'^/(auth|storage|compute|editor-sessions|sandbox-image|apps|ai|secrets|integrations|syncing|workload-identity-federation)',
				items: [
					{ text: 'Storage', link: '/storage' },
					{ text: 'Compute', link: '/compute' },
					{ text: 'Editor sessions', link: '/editor-sessions' },
					{ text: 'Auth', link: '/auth' },
					{ text: 'Sandbox image', link: '/sandbox-image' },
					{ text: 'Notebook apps', link: '/apps' },
					{ text: 'Managed AI', link: '/ai' },
					{ text: 'Project secrets', link: '/secrets' },
					{ text: 'Project integrations', link: '/integrations' },
					{ text: 'Syncing from external sources', link: '/syncing' },
					{ text: 'Workload Identity Federation', link: '/workload-identity-federation' },
				],
			},
			{ text: 'Deploy', link: '/deploying/', activeMatch: '^/deploying/' },
			{
				text: 'Operate',
				activeMatch: '^/(security|operations|troubleshooting)',
				items: [
					{ text: 'Security', link: '/security' },
					{ text: 'Operations', link: '/operations' },
					{ text: 'Troubleshooting', link: '/troubleshooting' },
				],
			},
			{
				text: 'Reference',
				activeMatch: '^/(configuration|api|architecture|agent-guide)',
				items: [
					{ text: 'Configuration', link: '/configuration' },
					{ text: 'API & client', link: '/api' },
					{ text: 'API tokens', link: '/api-tokens' },
					{ text: 'How it works', link: '/architecture' },
					{ text: 'Agent guide', link: '/agent-guide' },
				],
			},
			{ text: 'Contribute', link: '/contributing/docs-style' },
		],

		sidebar: [
			{
				text: 'Start',
				items: [
					{ text: 'Overview', link: '/' },
					{ text: 'Getting started', link: '/getting-started' },
					{ text: 'Testing locally', link: '/testing-locally' },
					{ text: 'Deployment options', link: '/deployment-options' },
				],
			},
			{
				text: 'Configure',
				items: [
					{ text: 'Storage', link: '/storage' },
					{ text: 'Compute', link: '/compute' },
					{ text: 'Editor sessions', link: '/editor-sessions' },
					{ text: 'Auth', link: '/auth' },
					{ text: 'Sandbox image', link: '/sandbox-image' },
					{ text: 'Notebook apps', link: '/apps' },
					{ text: 'Managed AI', link: '/ai' },
					{ text: 'Project secrets', link: '/secrets' },
					{ text: 'Project integrations', link: '/integrations' },
					{ text: 'Syncing from external sources', link: '/syncing' },
					{ text: 'Workload Identity Federation', link: '/workload-identity-federation' },
				],
			},
			{
				text: 'Deploying',
				link: '/deploying/',
				collapsed: false,
				items: [
					{ text: 'Helm', link: '/deploying/helm' },
					{ text: 'Single instance', link: '/deploying/single-instance' },
					{ text: 'CoreWeave (CKS)', link: '/deploying/cks' },
					{ text: 'Kubernetes', link: '/deploying/kubernetes' },
					{ text: 'GCP', link: '/deploying/gcp' },
					{ text: 'AWS', link: '/deploying/aws' },
					{ text: 'Cloudflare', link: '/deploying/cloudflare' },
				],
			},
			{
				text: 'Operating',
				items: [
					{ text: 'Security', link: '/security' },
					{ text: 'Operations', link: '/operations' },
					{ text: 'Troubleshooting', link: '/troubleshooting' },
				],
			},
			{
				text: 'Reference',
				items: [
					{ text: 'Configuration', link: '/configuration' },
					{ text: 'API & client', link: '/api' },
					{ text: 'API tokens', link: '/api-tokens' },
					{ text: 'How it works', link: '/architecture' },
					{ text: 'Agent guide', link: '/agent-guide' },
				],
			},
			{
				text: 'Contribute',
				items: [{ text: 'Documentation style', link: '/contributing/docs-style' }],
			},
		],

		outline: { level: [2, 3], label: 'On this page' },

		editLink: {
			pattern: `${REPO}/edit/main/docs/:path`,
			text: 'Edit this page on GitHub',
		},

		search: { provider: 'local' },

		socialLinks: [{ icon: 'github', link: REPO }],

		footer: {
			message: 'Provider-agnostic. Deploy anywhere.',
			copyright: 'Copyright © marimo',
		},
	},
});
