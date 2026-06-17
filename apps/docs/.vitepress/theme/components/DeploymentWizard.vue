<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import {
	generateCompose,
	generateEnv,
	generateHelm,
	generateLibrary,
	validateSelection,
} from '../../wizard/generate';
import type { WizardSelection } from '../../wizard/generate';
import { backendFor, EXTRA_OPTIONS, SELECTABLE_GROUPS } from '../../wizard/spec';
import BackendPicker from './BackendPicker.vue';
import CodeOutput from './CodeOutput.vue';
import SetupSection from './SetupSection.vue';

type SelectKey = 'storage' | 'compute' | 'auth' | 'ai';

function groupDefault(key: SelectKey): string {
	return SELECTABLE_GROUPS.find((g) => g.key === key)?.default ?? '';
}

const optionDefaults = (): Record<string, string> =>
	Object.fromEntries(EXTRA_OPTIONS.map((o) => [o.id, o.default]));

const selection = reactive<WizardSelection>({
	storage: groupDefault('storage'),
	compute: groupDefault('compute'),
	auth: groupDefault('auth'),
	ai: groupDefault('ai'),
	options: optionDefaults(),
});

// Shareable state: hydrate from the URL hash on load, then keep it in sync so a
// configured selection can be copied as a link. Guarded for SSR (no `window`).
const HASH_KEYS = { s: 'storage', c: 'compute', a: 'auth', i: 'ai' } as const;

function isValid(key: SelectKey, value: string): boolean {
	return Boolean(backendFor(key, value));
}

if (typeof window !== 'undefined') {
	const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
	for (const [short, key] of Object.entries(HASH_KEYS)) {
		const v = params.get(short);
		if (v && isValid(key, v)) selection[key] = v;
	}
	for (const opt of EXTRA_OPTIONS) {
		const v = params.get(opt.id);
		if (v !== null) selection.options![opt.id] = v;
	}

	watch(
		selection,
		(sel) => {
			const next = new URLSearchParams();
			next.set('s', sel.storage);
			next.set('c', sel.compute);
			next.set('a', sel.auth);
			if (sel.ai) next.set('i', sel.ai);
			for (const opt of EXTRA_OPTIONS) {
				const v = sel.options?.[opt.id];
				if (v) next.set(opt.id, v);
			}
			history.replaceState(null, '', `#${next.toString()}`);
		},
		{ deep: true },
	);
}

const env = computed(() => generateEnv(selection));
const helm = computed(() => generateHelm(selection));
const compose = computed(() => generateCompose(selection));
const library = computed(() => generateLibrary(selection));
const warnings = computed(() => validateSelection(selection));

/** Short description of the active backend, shown under each picker. */
function activeDescription(key: SelectKey): string {
	return backendFor(key, selection[key] ?? '')?.description ?? '';
}
</script>

<template>
	<div class="wizard">
		<div class="wizard__controls">
			<template v-for="group in SELECTABLE_GROUPS" :key="group.key">
				<BackendPicker
					v-model="selection[group.key]"
					:label="group.label"
					:options="group.backends"
				/>
				<p class="wizard__hint">{{ activeDescription(group.key) }}</p>
			</template>

			<fieldset class="wizard__extras">
				<legend class="wizard__extras-label">Options</legend>
				<div v-for="opt in EXTRA_OPTIONS" :key="opt.id" class="wizard__extra">
					<label class="wizard__extra-name" :for="opt.id">{{ opt.label }}</label>
					<select
						v-if="opt.kind === 'enum'"
						:id="opt.id"
						v-model="selection.options![opt.id]"
						class="wizard__select"
					>
						<option v-for="choice in opt.choices" :key="choice" :value="choice">
							{{ choice }}
						</option>
					</select>
					<input
						v-else
						:id="opt.id"
						v-model="selection.options![opt.id]"
						type="text"
						class="wizard__input"
						:placeholder="opt.default || 'optional'"
					/>
					<p class="wizard__hint wizard__hint--tight">{{ opt.description }}</p>
				</div>
			</fieldset>
		</div>

		<div class="wizard__output">
			<ul v-if="warnings.length" class="wizard__warnings">
				<li v-for="w in warnings" :key="w.title" class="custom-block" :class="w.level">
					<p class="custom-block-title">{{ w.title }}</p>
					<p>{{ w.message }}</p>
				</li>
			</ul>
			<CodeOutput :env="env" :helm="helm" :compose="compose" :library="library" />
		</div>
	</div>

	<SetupSection :selection="selection" />
</template>

<style scoped>
.wizard {
	display: grid;
	grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr);
	gap: 1.5rem;
	margin: 1.5rem 0;
	padding: 1.25rem;
	border: 1px solid var(--vp-c-divider);
	border-radius: 16px;
	background: linear-gradient(180deg, var(--vp-c-bg-soft), var(--vp-c-bg));
}

@media (max-width: 860px) {
	.wizard {
		grid-template-columns: 1fr;
	}
}

.wizard__warnings {
	list-style: none;
	margin: 0 0 0.9rem;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: 0.5rem;
}

.wizard__warnings .custom-block {
	margin: 0;
	border: 1px solid transparent;
	border-radius: 8px;
	padding: 0.5rem 0.85rem;
}

.wizard__warnings .custom-block-title {
	margin: 0;
	font-weight: 700;
	font-size: 0.72rem;
	letter-spacing: 0.03em;
}

.wizard__warnings .custom-block p:not(.custom-block-title) {
	margin: 0.25rem 0 0;
	font-size: 0.82rem;
	line-height: 1.5;
}

.wizard__warnings .custom-block.danger {
	border-color: var(--vp-c-danger-1);
	background: var(--vp-custom-block-danger-bg);
	color: var(--vp-custom-block-danger-text, var(--vp-c-text-1));
}

.wizard__warnings .custom-block.warning {
	border-color: var(--vp-c-warning-1);
	background: var(--vp-custom-block-warning-bg);
	color: var(--vp-custom-block-warning-text, var(--vp-c-text-1));
}

.wizard__warnings .custom-block.info {
	border-color: var(--vp-c-default-1);
	background: var(--vp-custom-block-info-bg);
	color: var(--vp-custom-block-info-text, var(--vp-c-text-1));
}

.wizard__controls {
	display: flex;
	flex-direction: column;
	gap: 1.1rem;
}

.wizard__hint {
	margin: 0.4rem 0 0;
	font-size: 0.78rem;
	line-height: 1.4;
	color: var(--vp-c-text-2);
}

.wizard__hint--tight {
	margin-top: 0.3rem;
}

.wizard__extras {
	border: 1px dashed var(--vp-c-divider);
	border-radius: 12px;
	padding: 0.85rem 1rem;
	margin: 0;
}

.wizard__extras-label {
	font-size: 0.7rem;
	font-weight: 700;
	letter-spacing: 0.08em;
	text-transform: uppercase;
	color: var(--vp-c-text-2);
	padding: 0 0.3rem;
}

.wizard__extra + .wizard__extra {
	margin-top: 0.9rem;
}

.wizard__extra-name {
	display: block;
	font-size: 0.85rem;
	font-weight: 600;
	margin-bottom: 0.4rem;
}

.wizard__select {
	width: 100%;
	padding: 0.4rem 2rem 0.4rem 0.6rem;
	border: 1px solid var(--vp-c-divider);
	border-radius: 8px;
	background-color: var(--vp-c-bg);
	color: var(--vp-c-text-1);
	font-size: 0.82rem;
	cursor: pointer;
	appearance: none;
	background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
	background-repeat: no-repeat;
	background-position: right 0.6rem center;
	transition: border-color 0.15s ease;
}

.wizard__select:hover,
.wizard__select:focus {
	outline: none;
	border-color: var(--vp-c-brand-1);
}

.wizard__input {
	width: 100%;
	padding: 0.4rem 0.6rem;
	border: 1px solid var(--vp-c-divider);
	border-radius: 8px;
	background: var(--vp-c-bg);
	color: var(--vp-c-text-1);
	font-size: 0.82rem;
	font-family: var(--vp-font-family-mono);
}

.wizard__input:focus {
	outline: none;
	border-color: var(--vp-c-brand-1);
}

.wizard__output {
	min-width: 0;
}
</style>
