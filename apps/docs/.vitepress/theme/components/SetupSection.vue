<script setup lang="ts">
import { computed } from 'vue';
import { renderMarkdown } from '../../wizard/markdown';
import { getSetup } from '../../wizard/setup';
import { backendFor, SELECTABLE_GROUPS } from '../../wizard/spec';
import type { WizardSelectionKeys } from '../../wizard/spec';

const props = defineProps<{
	selection: WizardSelectionKeys;
}>();

/** One panel per port for the currently-selected backend. */
const panels = computed(() =>
	SELECTABLE_GROUPS.map((group) => {
		const value = props.selection[group.key];
		const backend = backendFor(group.key, value);
		const setup = getSetup(group.key, value);
		return {
			key: group.key,
			label: group.label,
			icon: backend?.icon ?? '•',
			name: backend?.name ?? value,
			html: setup ? renderMarkdown(setup.markdown) : '',
			docHref: setup?.docHref,
		};
	}),
);
</script>

<template>
	<section class="setup">
		<h3 class="setup__title">Setup</h3>
		<p class="setup__intro">How to provision and connect each backend you picked above.</p>

		<details v-for="(panel, i) in panels" :key="panel.key" class="setup__item" :open="i === 0">
			<summary class="setup__summary">
				<span class="setup__icon" aria-hidden="true">{{ panel.icon }}</span>
				<span class="setup__label">{{ panel.label }}</span>
				<span class="setup__name">{{ panel.name }}</span>
				<a v-if="panel.docHref" class="setup__docs" :href="panel.docHref" @click.stop>
					Full docs →
				</a>
			</summary>
			<!-- First-party markdown rendered with html:false — safe to inline. -->
			<div class="setup__body setup-md" v-html="panel.html" />
		</details>
	</section>
</template>

<style scoped>
.setup {
	margin-top: 1.5rem;
	padding: 1.25rem;
	border: 1px solid var(--vp-c-divider);
	border-radius: 16px;
	background: var(--vp-c-bg-soft);
}

.setup__title {
	margin: 0;
	font-size: 1.1rem;
	font-weight: 700;
	letter-spacing: -0.01em;
}

.setup__intro {
	margin: 0.25rem 0 1rem;
	font-size: 0.85rem;
	color: var(--vp-c-text-2);
}

.setup__item {
	border: 1px solid var(--vp-c-divider);
	border-radius: 12px;
	background: var(--vp-c-bg);
	margin-bottom: 0.6rem;
	overflow: hidden;
}

.setup__item[open] {
	border-color: var(--vp-c-brand-1);
}

.setup__summary {
	display: flex;
	align-items: center;
	gap: 0.6rem;
	padding: 0.7rem 0.9rem;
	cursor: pointer;
	list-style: none;
	user-select: none;
}

.setup__summary::-webkit-details-marker {
	display: none;
}

.setup__icon {
	font-size: 1.1rem;
	line-height: 1;
}

.setup__label {
	font-size: 0.7rem;
	font-weight: 700;
	letter-spacing: 0.08em;
	text-transform: uppercase;
	color: var(--vp-c-text-2);
}

.setup__name {
	font-weight: 600;
	font-size: 0.92rem;
}

.setup__docs {
	margin-left: auto;
	font-size: 0.8rem;
	font-weight: 600;
	color: var(--vp-c-brand-1);
	white-space: nowrap;
}

.setup__docs:hover {
	text-decoration: underline;
}

.setup__body {
	padding: 0.25rem 1.1rem 1rem;
	border-top: 1px solid var(--vp-c-divider);
}

/* Rendered-markdown styling (kept light; matches the docs feel). */
.setup__body :deep(h3) {
	font-size: 1rem;
	font-weight: 700;
	margin: 1.1rem 0 0.4rem;
}

.setup__body :deep(p) {
	margin: 0.6rem 0;
	font-size: 0.88rem;
	line-height: 1.6;
	color: var(--vp-c-text-1);
}

.setup__body :deep(ol),
.setup__body :deep(ul) {
	margin: 0.6rem 0;
	padding-left: 1.3rem;
	font-size: 0.88rem;
	line-height: 1.6;
}

.setup__body :deep(li) {
	margin: 0.2rem 0;
}

.setup__body :deep(a) {
	color: var(--vp-c-brand-1);
	font-weight: 500;
}

.setup__body :deep(a:hover) {
	text-decoration: underline;
}

.setup__body :deep(code) {
	font-family: var(--vp-font-family-mono);
	font-size: 0.82em;
	background: var(--vp-c-bg-soft);
	padding: 0.15em 0.35em;
	border-radius: 4px;
}

.setup__body :deep(pre) {
	background: var(--vp-code-block-bg, var(--vp-c-bg-alt));
	border: 1px solid var(--vp-c-divider);
	border-radius: 8px;
	padding: 0.8rem 1rem;
	overflow-x: auto;
	margin: 0.7rem 0;
}

.setup__body :deep(pre code) {
	background: none;
	padding: 0;
	font-size: 0.8rem;
	line-height: 1.55;
}

.setup__body :deep(blockquote) {
	margin: 0.7rem 0;
	padding: 0.1rem 0.9rem;
	border-left: 3px solid var(--vp-c-brand-1);
	color: var(--vp-c-text-2);
	font-size: 0.85rem;
}

/* Tip/warning/info/danger callouts — mirror VitePress's custom blocks, reusing
   its CSS vars so they match the docs exactly in light + dark. */
.setup__body :deep(.custom-block) {
	margin: 0.8rem 0;
	border: 1px solid transparent;
	border-radius: 8px;
	padding: 0.6rem 1rem;
	font-size: 0.85rem;
	line-height: 1.6;
}

.setup__body :deep(.custom-block .custom-block-title) {
	margin: 0;
	font-weight: 700;
	font-size: 0.74rem;
	letter-spacing: 0.04em;
}

.setup__body :deep(.custom-block p:not(.custom-block-title)) {
	margin: 0.4rem 0 0;
	font-size: 0.85rem;
}

.setup__body :deep(.custom-block.tip) {
	border-color: var(--vp-c-tip-1);
	background: var(--vp-custom-block-tip-bg);
	color: var(--vp-custom-block-tip-text, var(--vp-c-text-1));
}

.setup__body :deep(.custom-block.info) {
	border-color: var(--vp-c-default-1);
	background: var(--vp-custom-block-info-bg);
	color: var(--vp-custom-block-info-text, var(--vp-c-text-1));
}

.setup__body :deep(.custom-block.warning) {
	border-color: var(--vp-c-warning-1);
	background: var(--vp-custom-block-warning-bg);
	color: var(--vp-custom-block-warning-text, var(--vp-c-text-1));
}

.setup__body :deep(.custom-block.danger) {
	border-color: var(--vp-c-danger-1);
	background: var(--vp-custom-block-danger-bg);
	color: var(--vp-custom-block-danger-text, var(--vp-c-text-1));
}

.setup__body :deep(.custom-block code) {
	background: var(--vp-c-bg);
}
</style>
