import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { renderWithClient, setupUser } from '@/test/render';
import type * as PreviewsApi from '@/api/previews';
import { CreatePreviewForm, PreviewsPage } from './PreviewsPage';

const state = vi.hoisted(() => ({
	role: 'manager',
	previewProviders: ['github'] as string[] | undefined,
	sourceType: 'local',
	notebook: vi.fn(),
	create: vi.fn(),
	remove: vi.fn(),
	previews: [] as PreviewsApi.NotebookPreview[],
}));
vi.mock('@/api/apps', () => ({ useAppQuery: () => ({ data: { your_role: state.role } }) }));
vi.mock('@/api/hooks', () => ({
	useNotebookQuery: () => state.notebook(),
	useCapabilitiesQuery: () => ({
		data: state.previewProviders
			? { source_control: { preview_providers: state.previewProviders } }
			: undefined,
		isSuccess: state.previewProviders !== undefined,
	}),
}));
vi.mock('@/api/previews', async (importOriginal) => ({
	...(await importOriginal<typeof PreviewsApi>()),
	usePreviewsQuery: () => ({ data: state.previews }),
	useDeletePreview: () => ({ mutate: state.remove, reset: vi.fn() }),
	useCreatePreview: () => ({ mutate: state.create }),
}));

vi.mock('./SourceRefInput', () => ({
	SourceRefInput: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
		<input
			aria-label="Source ref"
			value={value}
			onChange={(event) => onChange(event.target.value)}
		/>
	),
}));

function setup() {
	renderWithClient(
		<Routes>
			<Route path="/projects/:pid/notebooks/:nid/previews" element={<PreviewsPage />} />
		</Routes>,
		{ route: '/projects/p/notebooks/n/previews', toaster: false },
	);
}

beforeEach(() => {
	state.create.mockReset();
	state.remove.mockReset();
	state.previews = [];
	state.role = 'manager';
	state.previewProviders = ['github'];
	state.sourceType = 'local';
	state.notebook
		.mockReset()
		.mockImplementation(() => ({ data: { source: { type: state.sourceType } } }));
});

describe('preview creation eligibility', () => {
	it('explains why a local notebook cannot create previews', () => {
		setup();
		expect(screen.queryByRole('button', { name: 'Create preview' })).not.toBeInTheDocument();
		expect(screen.getByText('Preview creation requires a Git notebook.')).toBeInTheDocument();
	});

	it('offers preview creation for a Git notebook manager', () => {
		state.sourceType = 'git';
		setup();
		expect(screen.getByRole('button', { name: 'Create preview' })).toBeInTheDocument();
	});

	it.each([[[]], [undefined]])(
		'hides creation without confirmed preview capability: %s',
		(providers) => {
			state.previewProviders = providers;
			state.sourceType = 'git';
			setup();
			expect(screen.queryByRole('button', { name: 'Create preview' })).not.toBeInTheDocument();
			expect(state.notebook).not.toHaveBeenCalled();
			if (providers)
				expect(
					screen.getByText('Preview creation requires a GitHub App connection.'),
				).toBeInTheDocument();
		},
	);

	it('does not request privileged notebook source data for app-users', () => {
		state.role = 'app-user';
		setup();
		expect(state.notebook).not.toHaveBeenCalled();
		expect(screen.queryByRole('button', { name: 'Create preview' })).not.toBeInTheDocument();
	});
	it('reuses a creation key on retry and rotates it when the request changes', async () => {
		state.sourceType = 'git';
		const user = setupUser();
		renderWithClient(<CreatePreviewForm pid="p" nid="n" onCreated={() => {}} />);
		await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Review');
		await user.type(screen.getByRole('textbox', { name: 'Source ref' }), 'feature/chart');
		const submit = screen.getByRole('button', { name: 'Create preview' });
		await user.click(submit);
		await user.click(submit);
		const initial = state.create.mock.calls[0][0].requestKey;
		expect(state.create.mock.calls[1][0].requestKey).toBe(initial);
		await user.type(screen.getByRole('textbox', { name: 'Name' }), ' again');
		await user.click(submit);
		expect(state.create.mock.calls[2][0].requestKey).not.toBe(initial);
	});
});

describe('preview deletion', () => {
	it('requires confirmation, allows cancellation, and closes after deletion', async () => {
		state.previews = [
			{
				id: 'preview-1',
				name: 'Review build',
				preparation: 'ready',
				can: { manage: true },
				source_type: 'branch',
			} as PreviewsApi.NotebookPreview,
		];
		state.remove.mockImplementation((_id, { onSuccess }) => onSuccess());
		const user = setupUser();
		setup();
		await user.click(screen.getByRole('button', { name: 'Delete' }));
		expect(state.remove).not.toHaveBeenCalled();
		let dialog = screen.getByRole('dialog');
		expect(within(dialog).getByText(/Reviewers will lose access immediately/)).toBeInTheDocument();
		await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		expect(state.remove).not.toHaveBeenCalled();
		await user.click(screen.getByRole('button', { name: 'Delete' }));
		dialog = screen.getByRole('dialog');
		await user.click(within(dialog).getByRole('button', { name: 'Delete preview' }));
		expect(state.remove).toHaveBeenCalledWith(
			'preview-1',
			expect.objectContaining({ onSuccess: expect.any(Function) }),
		);
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
	});
});

describe('preview revision display', () => {
	it.each([undefined, 'a'.repeat(40)])(
		'shows the served revision while a newer head is pending: %s',
		(commit) => {
			state.previews = [
				{
					id: 'preview-1',
					name: 'Review build',
					preparation: 'pending',
					can: { manage: false, app: true, edit: false },
					source_type: 'branch',
					commit,
					target_commit: 'b'.repeat(40),
				} as PreviewsApi.NotebookPreview,
			];
			setup();
			expect(
				screen.getByText(commit ? /aaaaaaaaaaaa/ : /Awaiting first revision/),
			).toBeInTheDocument();
			expect(screen.queryByText(/bbbbbbbbbbbb/)).not.toBeInTheDocument();
		},
	);
});
