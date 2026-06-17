<script setup lang="ts">
import type { SelectableBackend } from '../../wizard/spec';

defineProps<{
	label: string;
	modelValue: string;
	options: SelectableBackend[];
}>();

defineEmits<{ (e: 'update:modelValue', value: string): void }>();
</script>

<template>
	<div class="picker">
		<label class="picker__label">{{ label }}</label>
		<select
			class="picker__select"
			:value="modelValue"
			@change="$emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
		>
			<option v-for="opt in options" :key="opt.value" :value="opt.value">
				{{ opt.icon }} {{ opt.name }}
			</option>
		</select>
	</div>
</template>

<style scoped>
.picker {
	display: flex;
	flex-direction: column;
}

.picker__label {
	font-size: 0.7rem;
	font-weight: 700;
	letter-spacing: 0.08em;
	text-transform: uppercase;
	color: var(--vp-c-text-2);
	margin-bottom: 0.4rem;
}

.picker__select {
	width: 100%;
	padding: 0.5rem 2rem 0.5rem 0.7rem;
	border: 1px solid var(--vp-c-divider);
	border-radius: 8px;
	background-color: var(--vp-c-bg);
	color: var(--vp-c-text-1);
	font-size: 0.9rem;
	font-weight: 500;
	cursor: pointer;
	appearance: none;
	background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
	background-repeat: no-repeat;
	background-position: right 0.7rem center;
	transition: border-color 0.15s ease;
}

.picker__select:hover,
.picker__select:focus {
	outline: none;
	border-color: var(--vp-c-brand-1);
}
</style>
