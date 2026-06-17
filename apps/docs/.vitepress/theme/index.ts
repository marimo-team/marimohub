import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import DeploymentWizard from './components/DeploymentWizard.vue';
import './style.css';

export default {
	extends: DefaultTheme,
	enhanceApp({ app }) {
		app.component('DeploymentWizard', DeploymentWizard);
	},
} satisfies Theme;
