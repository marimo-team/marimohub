import { KubeConfig } from '@kubernetes/client-node';
import { NotebookId, ProjectId, SandboxId } from '@marimo-hub/core/ids';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createK8sClient, podManifest } from './client';
import { validatePodTemplate } from './podTemplate';
import { NOTEBOOK_TITLE_ANNOTATION, SANDBOX_ID_ANNOTATION } from './shared';
import type { EnsureSandboxOptions } from './shared';

const options: EnsureSandboxOptions = {
	name: 'mh-annotations',
	namespace: 'kernels',
	sandboxId: SandboxId.parse('sb-aaaaaaaaaaaaaaaa'),
	image: 'runtime:v1',
	ports: [{ port: 2718, host: '' }],
};

const notebook = {
	projectId: ProjectId.parse('proj-aaaaaaaaaaaaaaaa'),
	notebookId: NotebookId.parse('nb-aaaaaaaaaaaaaaaa'),
	title: '',
};

function templateAtMergedLimit(character: string, extraBytes = 0) {
	const fixed = {
		'example.com/owner': 'data',
		[SANDBOX_ID_ANNOTATION]: String(options.sandboxId),
	};
	const paddingKey = 'example.com/padding';
	const remainingBytes =
		256 * 1024 -
		Object.entries(fixed).reduce(
			(total, [key, value]) => total + Buffer.byteLength(key) + Buffer.byteLength(value),
			0,
		) -
		Buffer.byteLength(paddingKey) +
		extraBytes;
	const width = Buffer.byteLength(character);
	return {
		metadata: {
			annotations: {
				'example.com/owner': fixed['example.com/owner'],
				[paddingKey]:
					character.repeat(Math.floor(remainingBytes / width)) + 'a'.repeat(remainingBytes % width),
			},
		},
	};
}

describe('merged Pod annotation size', () => {
	afterEach(() => vi.restoreAllMocks());

	it.each(['', 'a', 'é', '😀'])('retains title %j exactly at the merged byte limit', (title) => {
		const podTemplate = templateAtMergedLimit(
			'a',
			-Buffer.byteLength(NOTEBOOK_TITLE_ANNOTATION) - Buffer.byteLength(title),
		);
		expect(
			podManifest({ ...options, podTemplate, notebook: { ...notebook, title } }).metadata
				?.annotations,
		).toEqual({
			...podTemplate.metadata.annotations,
			[SANDBOX_ID_ANNOTATION]: options.sandboxId,
			[NOTEBOOK_TITLE_ANNOTATION]: title,
		});
	});

	it.each(['', 'a', 'é', '😀'])(
		'omits title %j when it exceeds the budget by one byte',
		(title) => {
			const podTemplate = templateAtMergedLimit(
				'a',
				1 - Buffer.byteLength(NOTEBOOK_TITLE_ANNOTATION) - Buffer.byteLength(title),
			);
			const metadata = podManifest({
				...options,
				podTemplate,
				notebook: { ...notebook, title },
			}).metadata;
			expect(metadata?.annotations).toEqual({
				...podTemplate.metadata.annotations,
				[SANDBOX_ID_ANNOTATION]: options.sandboxId,
			});
			expect(metadata?.labels).toMatchObject({
				'marimohub.io/project-id': notebook.projectId,
				'marimohub.io/notebook-id': notebook.notebookId,
			});
		},
	);

	it('omits an oversized Unicode title without a template', () => {
		expect(
			podManifest({ ...options, notebook: { ...notebook, title: '😀'.repeat(70_000) } }).metadata
				?.annotations,
		).toEqual({ [SANDBOX_ID_ANNOTATION]: options.sandboxId });
	});

	it.each(['a', 'é', '😀'])('accepts exactly 256 KiB including identity with %s values', (char) => {
		const podTemplate = templateAtMergedLimit(char);
		expect(podManifest({ ...options, podTemplate }).metadata?.annotations).toEqual({
			...podTemplate.metadata.annotations,
			[SANDBOX_ID_ANNOTATION]: options.sandboxId,
		});
	});

	it.each(['a', 'é', '😀'])('rejects one byte above the merged limit with %s values', (char) => {
		const podTemplate = templateAtMergedLimit(char, 1);
		expect(() => validatePodTemplate(podTemplate)).not.toThrow();
		expect(() => podManifest({ ...options, podTemplate })).toThrow(
			'annotations exceed the Kubernetes 256 KiB limit',
		);
	});

	it('rejects overflow before loading Kubernetes credentials or initializing API clients', async () => {
		const failCredentialLoad = () => {
			throw new Error('Tests must not load Kubernetes credentials');
		};
		const loadFromCluster = vi
			.spyOn(KubeConfig.prototype, 'loadFromCluster')
			.mockImplementation(failCredentialLoad);
		const loadFromDefault = vi
			.spyOn(KubeConfig.prototype, 'loadFromDefault')
			.mockImplementation(failCredentialLoad);
		const makeApiClient = vi.spyOn(KubeConfig.prototype, 'makeApiClient');
		const client = createK8sClient({ namespace: options.namespace });
		await expect(
			client.ensure({ ...options, podTemplate: templateAtMergedLimit('a', 1) }),
		).rejects.toThrow('annotations exceed the Kubernetes 256 KiB limit');
		expect(loadFromCluster).not.toHaveBeenCalled();
		expect(loadFromDefault).not.toHaveBeenCalled();
		expect(makeApiClient).not.toHaveBeenCalled();
	});
});
