<script setup lang="ts">
import { computed, ref } from 'vue';
import { highlight } from '../../wizard/highlight';
import type { HighlightLang } from '../../wizard/highlight';

const props = defineProps<{
	env: string;
	helm: string;
	compose: string;
	library: string;
}>();

type Tab = 'configs' | 'library';
type Format = 'env' | 'helm' | 'compose';

const tab = ref<Tab>('configs');
const format = ref<Format>('env');
const copied = ref(false);

const current = computed(() => {
	if (tab.value === 'library') return props.library;
	if (format.value === 'helm') return props.helm;
	if (format.value === 'compose') return props.compose;
	return props.env;
});

const language = computed<HighlightLang>(() => {
	if (tab.value === 'library') return 'ts';
	return format.value === 'env' ? 'sh' : 'yaml';
});

/** Suggested filename for the current view, used by the download button. */
const filename = computed(() => {
	if (tab.value === 'library') return 'marimohub.ts';
	if (format.value === 'helm') return 'values.yaml';
	if (format.value === 'compose') return 'docker-compose.yml';
	return '.env';
});

const highlighted = computed(() => highlight(current.value, language.value));

async function copy() {
	try {
		await navigator.clipboard.writeText(current.value);
		copied.value = true;
		setTimeout(() => (copied.value = false), 1500);
	} catch {
		copied.value = false;
	}
}

function download() {
	const blob = new Blob([current.value], { type: 'text/plain' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename.value;
	a.click();
	URL.revokeObjectURL(url);
}
</script>

<template>
	<div class="code">
		<div class="code__bar">
			<div class="code__tabs" role="tablist">
				<button
					type="button"
					role="tab"
					class="code__tab"
					:class="{ 'code__tab--active': tab === 'configs' }"
					:aria-selected="tab === 'configs'"
					@click="tab = 'configs'"
				>
					Configs
				</button>
				<button
					type="button"
					role="tab"
					class="code__tab"
					:class="{ 'code__tab--active': tab === 'library' }"
					:aria-selected="tab === 'library'"
					@click="tab = 'library'"
				>
					Library
				</button>
			</div>

			<div v-if="tab === 'configs'" class="code__formats">
				<button
					type="button"
					class="code__format"
					:class="{ 'code__format--active': format === 'env' }"
					@click="format = 'env'"
				>
					.env
				</button>
				<button
					type="button"
					class="code__format"
					:class="{ 'code__format--active': format === 'helm' }"
					@click="format = 'helm'"
				>
					Helm
				</button>
				<button
					type="button"
					class="code__format"
					:class="{ 'code__format--active': format === 'compose' }"
					@click="format = 'compose'"
				>
					Compose
				</button>
			</div>

			<div class="code__actions">
				<button type="button" class="code__action" title="Download" @click="download">
					Download
				</button>
				<button type="button" class="code__action code__action--copy" @click="copy">
					{{ copied ? '✓ Copied' : 'Copy' }}
				</button>
			</div>
		</div>

		<pre class="code__pre"><code :class="`language-${language}`" v-html="highlighted" /></pre>
	</div>
</template>

<style scoped>
.code {
	border: 1px solid var(--vp-c-divider);
	border-radius: 12px;
	overflow: hidden;
	background: var(--vp-code-block-bg, var(--vp-c-bg-alt));
}

.code__bar {
	display: flex;
	align-items: center;
	gap: 0.75rem;
	padding: 0.4rem 0.6rem;
	border-bottom: 1px solid var(--vp-c-divider);
	background: var(--vp-c-bg-soft);
}

.code__tabs {
	display: flex;
	gap: 0.25rem;
}

.code__tab {
	padding: 0.35rem 0.85rem;
	border: none;
	border-radius: 8px;
	background: transparent;
	color: var(--vp-c-text-2);
	font-size: 0.8rem;
	font-weight: 700;
	letter-spacing: 0.03em;
	cursor: pointer;
	transition: all 0.15s ease;
}

.code__tab--active {
	background: var(--vp-c-brand-soft);
	color: var(--vp-c-brand-1);
}

.code__formats {
	display: flex;
	gap: 0.2rem;
	padding: 0.15rem;
	border-radius: 8px;
	background: var(--vp-c-bg);
	border: 1px solid var(--vp-c-divider);
}

.code__format {
	padding: 0.2rem 0.6rem;
	border: none;
	border-radius: 6px;
	background: transparent;
	color: var(--vp-c-text-2);
	font-size: 0.75rem;
	font-family: var(--vp-font-family-mono);
	cursor: pointer;
	transition: all 0.15s ease;
}

.code__format--active {
	background: var(--vp-c-brand-1);
	color: var(--vp-c-bg);
}

.code__actions {
	margin-left: auto;
	display: flex;
	gap: 0.35rem;
}

.code__action {
	padding: 0.3rem 0.75rem;
	border: 1px solid var(--vp-c-divider);
	border-radius: 8px;
	background: var(--vp-c-bg);
	color: var(--vp-c-text-1);
	font-size: 0.75rem;
	font-weight: 600;
	cursor: pointer;
	transition: all 0.15s ease;
}

.code__action:hover {
	border-color: var(--vp-c-brand-1);
	color: var(--vp-c-brand-1);
}

.code__pre {
	margin: 0;
	padding: 1rem 1.1rem;
	overflow-x: auto;
	max-height: 900px;
	overflow-y: auto;
	font-family: var(--vp-font-family-mono);
	font-size: 0.82rem;
	line-height: 1.55;
	color: var(--vp-c-text-1);
	white-space: pre;
	tab-size: 2;
}

.code__pre code {
	background: transparent;
	padding: 0;
	border: none;
	font-size: inherit;
}

/* Syntax tokens — soft palette tuned for both themes. */
.code__pre :deep(.t-comment) {
	color: var(--vp-c-text-3);
	font-style: italic;
}
.code__pre :deep(.t-key) {
	color: #0e7490;
}
.code__pre :deep(.t-val) {
	color: var(--vp-c-text-1);
}
.code__pre :deep(.t-op) {
	color: var(--vp-c-text-3);
}
.code__pre :deep(.t-str) {
	color: #15803d;
}
.code__pre :deep(.t-kw) {
	color: #9333ea;
	font-weight: 600;
}
.code__pre :deep(.t-env) {
	color: #b45309;
}

.dark .code__pre :deep(.t-key) {
	color: #5eead4;
}
.dark .code__pre :deep(.t-str) {
	color: #86efac;
}
.dark .code__pre :deep(.t-kw) {
	color: #d8b4fe;
}
.dark .code__pre :deep(.t-env) {
	color: #fcd34d;
}
</style>
