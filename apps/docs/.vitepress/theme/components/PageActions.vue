<script setup lang="ts">
import { useRoute } from 'vitepress';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { mdUrlForPath } from '../mdUrl';

const route = useRoute();
const root = ref<HTMLElement | null>(null);
const open = ref(false);
const copied = ref(false);

const mdPath = computed(() => mdUrlForPath(route.path));

function promptFor(mdUrl: string): string {
	return `Read from ${mdUrl} so I can ask questions about it.`;
}

async function fetchMarkdown(): Promise<string | null> {
	try {
		const response = await fetch(mdPath.value);
		const contentType = response.headers.get('content-type') ?? '';
		// In `vitepress dev` the .md path serves the rendered HTML page, not raw
		// markdown — treat that as a miss and fall back to the DOM text.
		if (response.ok && contentType.includes('markdown')) return await response.text();
	} catch {
		// fall through to the DOM fallback
	}
	return null;
}

async function copyText(text: string): Promise<void> {
	if (navigator.clipboard && window.isSecureContext) {
		await navigator.clipboard.writeText(text);
		return;
	}
	const textarea = document.createElement('textarea');
	textarea.value = text;
	textarea.style.position = 'fixed';
	textarea.style.opacity = '0';
	document.body.appendChild(textarea);
	textarea.select();
	document.execCommand('copy');
	textarea.remove();
}

async function copyMarkdown(): Promise<void> {
	const markdown = (await fetchMarkdown()) ?? document.querySelector('.vp-doc')?.textContent ?? '';
	await copyText(markdown);
	copied.value = true;
	setTimeout(() => {
		copied.value = false;
		open.value = false;
	}, 1200);
}

function openIn(base: string): void {
	const mdUrl = new URL(mdPath.value, window.location.origin).href;
	window.open(base + encodeURIComponent(promptFor(mdUrl)), '_blank', 'noopener,noreferrer');
	open.value = false;
}

function onDocumentClick(event: MouseEvent): void {
	if (root.value && !root.value.contains(event.target as Node)) open.value = false;
}

function onKeydown(event: KeyboardEvent): void {
	if (event.key === 'Escape') open.value = false;
}

onMounted(() => {
	document.addEventListener('click', onDocumentClick);
	document.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
	document.removeEventListener('click', onDocumentClick);
	document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
	<div ref="root" class="page-actions">
		<button
			type="button"
			class="page-actions-toggle"
			aria-haspopup="menu"
			:aria-expanded="open"
			@click="open = !open"
		>
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				aria-hidden="true"
			>
				<rect x="9" y="9" width="13" height="13" rx="2" />
				<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
			</svg>
			Copy page
			<svg
				class="chevron"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				aria-hidden="true"
			>
				<path d="m6 9 6 6 6-6" />
			</svg>
		</button>

		<div v-if="open" class="page-actions-menu" role="menu">
			<button type="button" role="menuitem" class="page-actions-item" @click="copyMarkdown">
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					aria-hidden="true"
				>
					<rect x="9" y="9" width="13" height="13" rx="2" />
					<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
				</svg>
				{{ copied ? 'Copied!' : 'Copy as Markdown' }}
			</button>
			<button
				type="button"
				role="menuitem"
				class="page-actions-item"
				@click="openIn('https://claude.ai/new?q=')"
			>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					aria-hidden="true"
				>
					<path d="M15 3h6v6" />
					<path d="M10 14 21 3" />
					<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
				</svg>
				Open in Claude
			</button>
			<button
				type="button"
				role="menuitem"
				class="page-actions-item"
				@click="openIn('https://chatgpt.com/?q=')"
			>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					aria-hidden="true"
				>
					<path d="M15 3h6v6" />
					<path d="M10 14 21 3" />
					<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
				</svg>
				Open in ChatGPT
			</button>
		</div>
	</div>
</template>

<style scoped>
.page-actions {
	position: relative;
	display: inline-block;
	margin-bottom: 16px;
}

.page-actions-toggle {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 4px 12px;
	border: 1px solid var(--vp-c-divider);
	border-radius: 8px;
	font-size: 13px;
	font-weight: 500;
	color: var(--vp-c-text-1);
	transition:
		border-color 0.25s,
		background-color 0.25s;
}

.page-actions-toggle:hover {
	border-color: var(--vp-c-brand-1);
}

.page-actions-toggle svg {
	width: 14px;
	height: 14px;
}

.page-actions-toggle .chevron {
	width: 12px;
	height: 12px;
	color: var(--vp-c-text-3);
}

.page-actions-menu {
	position: absolute;
	top: calc(100% + 4px);
	left: 0;
	z-index: 30;
	min-width: 200px;
	padding: 4px;
	border: 1px solid var(--vp-c-divider);
	border-radius: 8px;
	background-color: var(--vp-c-bg-elv);
	box-shadow: var(--vp-shadow-3);
}

.page-actions-item {
	display: flex;
	align-items: center;
	gap: 8px;
	width: 100%;
	padding: 6px 10px;
	border-radius: 6px;
	font-size: 13px;
	color: var(--vp-c-text-1);
	text-align: left;
	transition: background-color 0.25s;
}

.page-actions-item:hover {
	background-color: var(--vp-c-default-soft);
}

.page-actions-item svg {
	width: 14px;
	height: 14px;
	color: var(--vp-c-text-2);
	flex-shrink: 0;
}
</style>
