import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { mapRuntimeEvent, mapRuntimeProblem, NOTEBOOK_KINDS, RUNTIME_ROUTES } from './protocol';

const source = new URL('../../../internal/host-protocol/vendor/', import.meta.url);
function fixture(path: string) {
	return JSON.parse(readFileSync(new URL(path, source), 'utf8'));
}

describe('pinned upstream contract', () => {
	it('matches the upstream route and operation identifiers', () => {
		const spec = z
			.object({
				paths: z.record(
					z.string(),
					z.record(z.string(), z.looseObject({ operationId: z.string().optional() })),
				),
			})
			.parse(fixture('openapi.json'));
		for (const route of RUNTIME_ROUTES) {
			const path = `/notebooks/{notebook_id}${route.path.replace(':run', '{run_id}').replace(':input', '{input_id}')}`;
			expect(spec.paths[path][route.method.toLowerCase()].operationId).toBe(route.operation);
		}
	});

	it('maps current edit and precondition responses without changing cell versions', () => {
		const edit = z
			.looseObject({ document: z.record(z.string(), z.unknown()) })
			.parse(fixture('fixtures/edit-response.json'));
		expect(
			mapRuntimeEvent({ event: 'edit', data: { edit } }, 'hub:notebook', 'session').data.edit,
		).toEqual({ ...edit, document: { ...edit.document, notebook_id: 'hub:notebook' } });
		const problem = z
			.looseObject({
				document: z.record(z.string(), z.unknown()),
				cell: z.record(z.string(), z.unknown()),
			})
			.parse(fixture('fixtures/problems/precondition-failed.json'));
		expect(mapRuntimeProblem(problem, 'hub:notebook')).toEqual({
			...problem,
			cell: { ...problem.cell, notebook_id: 'hub:notebook' },
			document: { ...problem.document, notebook_id: 'hub:notebook' },
		});
	});

	it('accepts every stable notebook snapshot kind and preserves output payloads', () => {
		const text = readFileSync(new URL('fixtures/notebook-events.sse', source), 'utf8');
		for (const frame of text.trim().split('\n\n')) {
			const lines = frame.split('\n');
			const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
			if (!event) continue;
			if (event === 'ready') continue;
			expect(NOTEBOOK_KINDS).toContain(event);
			const data = z
				.record(z.string(), z.unknown())
				.parse(JSON.parse(lines.find((line) => line.startsWith('data: '))!.slice(6)));
			const mapped = mapRuntimeEvent({ event, data }, 'hub:notebook', 'session');
			if (event === 'output') expect(mapped.data).toEqual(data);
		}
	});
});
