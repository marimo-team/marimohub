import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WorkingBranchActions } from './WorkingBranchActions';
import { setupUser } from '@/test/render';

const hooks = vi.hoisted(() => ({ status: vi.fn(), save: vi.fn(), open: vi.fn() }));
vi.mock('@/api/workingBranches', () => ({
	useWorkingBranch: hooks.status,
	useSaveToBranch: hooks.save,
	useOpenBranchPR: hooks.open,
}));
const props = {
	projectId: 'proj-1',
	notebookId: 'nb-1',
	sessionId: 'sess-1',
	canWrite: true,
	userId: 'user-1',
};
const mutate = vi.fn();
beforeEach(() => {
	vi.clearAllMocks();
	hooks.status.mockReturnValue({ data: { remote_commit: 'base' } });
	hooks.save.mockReturnValue({ mutate });
	hooks.open.mockReturnValue({ mutate: vi.fn() });
});
describe('WorkingBranchActions', () => {
	it('hides publishing and disables status fetching without capability or role', () => {
		render(<WorkingBranchActions {...props} canWrite={false} />);
		expect(screen.queryByRole('button')).toBeNull();
		expect(hooks.status).toHaveBeenCalledWith('proj-1', 'nb-1', false);
	});
	it('retries a failed status read without publishing a save', async () => {
		const refetch = vi.fn();
		hooks.status.mockReturnValue({ isError: true, error: new Error('Unavailable'), refetch });
		render(<WorkingBranchActions {...props} />);
		expect(screen.getByRole('button', { name: 'Save to branch' })).toBeDisabled();
		await setupUser().click(screen.getByRole('button', { name: 'Retry status' }));
		expect(refetch).toHaveBeenCalledTimes(1);
		expect(mutate).not.toHaveBeenCalled();
	});
	it('saves from the active session', async () => {
		render(<WorkingBranchActions {...props} />);
		await setupUser().click(screen.getByRole('button', { name: 'Save to branch' }));
		expect(mutate).toHaveBeenCalledWith(
			{ sessionId: 'sess-1', operationId: undefined },
			expect.any(Object),
		);
	});
	it('retries a persisted operation after the session has ended', async () => {
		hooks.status.mockReturnValue({ data: { active_save: 'save-id', remote_commit: 'base' } });
		render(<WorkingBranchActions {...props} sessionId={undefined} />);
		await setupUser().click(screen.getByRole('button', { name: 'Retry save' }));
		expect(mutate).toHaveBeenCalledWith(
			{ sessionId: undefined, operationId: 'save-id' },
			expect.any(Object),
		);
		expect(screen.getByRole('button', { name: 'Open PR' })).toBeDisabled();
	});
	it.each(['closed', 'merged'])('disables new saves for a %s PR but retains its link', (state) => {
		hooks.status.mockReturnValue({
			data: {
				remote_commit: 'base',
				change_request: { state, url: 'https://github.com/a/b/pull/1' },
			},
		});
		render(<WorkingBranchActions {...props} />);
		expect(screen.getByRole('button', { name: 'Save to branch' })).toBeDisabled();
		expect(screen.getByRole('link', { name: `View PR · ${state}` })).toHaveAttribute(
			'href',
			'https://github.com/a/b/pull/1',
		);
		expect(screen.queryByRole('button', { name: 'Open PR' })).toBeNull();
	});
	it('shows captured recovery alongside remote sync-pending state', () => {
		hooks.status.mockReturnValue({
			data: {
				active_save: 'save-id',
				last_save: {
					id: 'save-id',
					author: 'user-1',
					state: 'remote_committed',
					error: 'Committed remotely; hub synchronization is pending.',
					changes: [{ path: 'app.py' }],
					expires_at: '2099-01-01T00:00:00Z',
				},
			},
		});
		render(<WorkingBranchActions {...props} />);
		expect(screen.getByRole('status')).toHaveTextContent('hub synchronization is pending');
		expect(screen.getByRole('link', { name: 'Download recovery' })).toHaveAttribute(
			'href',
			'/api/v1/projects/proj-1/notebooks/nb-1/working-branch/saves/save-id/recovery',
		);
	});
	it('offers recovery to managers but not to other editors', () => {
		hooks.status.mockReturnValue({
			data: {
				last_save: {
					id: 'save-id',
					author: 'someone-else',
					state: 'conflict',
					changes: [{ path: 'app.py' }],
					expires_at: '2099-01-01T00:00:00Z',
				},
			},
		});
		const { rerender } = render(<WorkingBranchActions {...props} />);
		expect(screen.queryByRole('link', { name: 'Download recovery' })).toBeNull();
		rerender(<WorkingBranchActions {...props} canManage />);
		expect(screen.getByRole('link', { name: 'Download recovery' })).toBeInTheDocument();
	});
	it.each([
		'claimed',
		'captured',
		'commit_prepared',
		'complete',
		'no_changes',
		'conflict',
		'expired',
	])('does not offer expired %s payloads for download', (state) => {
		hooks.status.mockReturnValue({
			data: {
				last_save: {
					id: 'save-id',
					author: 'user-1',
					state,
					changes: [{ path: 'app.py' }],
					expires_at: '2020-01-01T00:00:00Z',
				},
			},
		});
		render(<WorkingBranchActions {...props} />);
		expect(screen.queryByRole('link', { name: 'Download recovery' })).toBeNull();
		expect(screen.getByText('Recovery capture expired.')).toBeInTheDocument();
	});
	it.each(['ref_dispatched', 'remote_committed', 'hub_synced'])(
		'keeps recovery for unresolved %s saves past their expiry date',
		(state) => {
			hooks.status.mockReturnValue({
				data: {
					active_save: 'save-id',
					last_save: {
						id: 'save-id',
						author: 'user-1',
						state,
						changes: [{ path: 'app.py' }],
						expires_at: '2020-01-01T00:00:00Z',
					},
				},
			});
			render(<WorkingBranchActions {...props} />);
			expect(screen.getByRole('link', { name: 'Download recovery' })).toBeInTheDocument();
			expect(screen.queryByText('Recovery capture expired.')).not.toBeInTheDocument();
		},
	);
});
