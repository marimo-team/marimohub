import { defineConfig } from 'vitepress';

const REPO = 'https://github.com/marimo-team/marimohub';

// Content lives in the repo-root docs/ folder; this package is just the site tooling.
export default defineConfig({
	title: 'marimohub',
	description:
		'Self-hostable, provider-agnostic platform for storing and running marimo notebooks.',
	srcDir: '../../docs',
	cleanUrls: true,
	lastUpdated: true,

	head: [
		['meta', { name: 'theme-color', content: '#14b8a6' }],
		['meta', { property: 'og:title', content: 'marimohub' }],
		[
			'meta',
			{
				property: 'og:description',
				content: 'Self-hostable, provider-agnostic platform for marimo notebooks.',
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

	// development_docs/ and charts/ links resolve on GitHub but aren't part of this site.
	ignoreDeadLinks: [/development_docs/, /charts\//],

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
					'^/(auth|storage|compute|sandbox-image|ai|secrets|syncing|workload-identity-federation)',
				items: [
					{ text: 'Storage', link: '/storage' },
					{ text: 'Compute', link: '/compute' },
					{ text: 'Auth', link: '/auth' },
					{ text: 'Sandbox image', link: '/sandbox-image' },
					{ text: 'Managed AI', link: '/ai' },
					{ text: 'Project secrets', link: '/secrets' },
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
				activeMatch: '^/(configuration|api|architecture)',
				items: [
					{ text: 'Configuration', link: '/configuration' },
					{ text: 'API & client', link: '/api' },
					{ text: 'How it works', link: '/architecture' },
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
					{ text: 'Auth', link: '/auth' },
					{ text: 'Sandbox image', link: '/sandbox-image' },
					{ text: 'Managed AI', link: '/ai' },
					{ text: 'Project secrets', link: '/secrets' },
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
					{ text: 'How it works', link: '/architecture' },
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
