import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import { h } from 'vue';
import DeploymentWizard from './components/DeploymentWizard.vue';
import PageActions from './components/PageActions.vue';
import './style.css';

export default {
	extends: DefaultTheme,
	// doc-before only renders on doc-layout pages, so the home page is skipped.
	Layout: () => h(DefaultTheme.Layout, null, { 'doc-before': () => h(PageActions) }),
	enhanceApp({ app }) {
		app.component('DeploymentWizard', DeploymentWizard);
	},
} satisfies Theme;
