import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChangeRequestActions } from './ChangeRequestActions';

const usePublisher = vi.hoisted(() => vi.fn());

vi.mock('@/api/changeRequests', () => ({
	notebookChangeRequestScope: (projectId: string, notebookId: string) =>
		JSON.stringify([projectId, notebookId]),
	useNotebookChangeRequestPublisher: usePublisher,
}));

const props = {
	projectId: 'proj-1',
	notebookId: 'nb-1',
	sessionId: 'sess-1',
	notebookTitle: 'Revenue dashboard',
	provider: 'github',
	canPublish: true,
};

function publication(proposalId: string, number: number) {
	return {
		proposal_id: proposalId,
		change_request: {
			provider: 'github',
			number,
			url: `https://github.com/owner/repo/pull/${number}`,
			head_branch: `proposal-${proposalId}`,
			head_commit: `commit-${proposalId}`,
		},
	};
}

beforeEach(() => {
	usePublisher.mockReturnValue({
		activeChangeRequest: undefined,
		isPending: false,
		mutate: vi.fn(),
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('ChangeRequestActions', () => {
	it('stays hidden until publishing is available for a running session', () => {
		const { rerender } = render(<ChangeRequestActions {...props} canPublish={false} />);
		expect(screen.queryByRole('button')).toBeNull();

		rerender(<ChangeRequestActions {...props} sessionId={undefined} />);
		expect(screen.queryByRole('button')).toBeNull();

		rerender(<ChangeRequestActions {...props} provider={null} />);
		expect(screen.queryByRole('button')).toBeNull();
	});

	it('keeps View PR available without a running publish session', () => {
		usePublisher.mockReturnValue({
			activeChangeRequest: {
				proposal_id: 'prop-1',
				change_request: {
					provider: 'github',
					number: 17,
					url: 'https://github.com/owner/repo/pull/17',
					head_branch: 'proposal-branch',
					head_commit: 'abc123',
				},
			},
			isPending: false,
			mutate: vi.fn(),
		});

		render(
			<ChangeRequestActions {...props} provider={null} sessionId={undefined} canPublish={false} />,
		);

		expect(screen.getByRole('button', { name: 'View PR' })).toBeEnabled();
		expect(screen.queryByRole('button', { name: 'pull request options' })).toBeNull();
	});

	it('closes an old publish popup when its request finishes after notebook navigation', async () => {
		const user = userEvent.setup();
		const mutate = vi.fn();
		usePublisher.mockReturnValue({
			activeChangeRequest: undefined,
			isPending: false,
			mutate,
		});
		const popup = {
			opener: window,
			location: { href: 'about:blank' },
			close: vi.fn(),
		};
		vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
		const { rerender } = render(<ChangeRequestActions {...props} />);

		await user.click(screen.getByRole('button', { name: 'Open PR' }));
		expect(mutate).toHaveBeenCalledOnce();
		const callbacks = mutate.mock.calls[0]?.[1] as {
			onSuccess: (data: ReturnType<typeof publication>) => void;
		};
		rerender(<ChangeRequestActions {...props} notebookId="nb-2" sessionId="sess-2" />);
		callbacks.onSuccess(publication('prop-1', 17));

		expect(popup.close).toHaveBeenCalledOnce();
		expect(popup.location.href).toBe('about:blank');
	});

	it('uses provider-specific and generic change-request terms', () => {
		const { rerender } = render(<ChangeRequestActions {...props} provider="gitlab" />);
		expect(screen.getByRole('button', { name: 'Open MR' })).toBeEnabled();

		rerender(<ChangeRequestActions {...props} provider="other" />);
		expect(screen.getByRole('button', { name: 'Open change request' })).toBeEnabled();
	});

	it('uses the current tab when a view popup is blocked', async () => {
		const user = userEvent.setup();
		usePublisher.mockReturnValue({
			activeChangeRequest: {
				proposal_id: 'prop-1',
				change_request: {
					provider: 'gitlab',
					number: 17,
					url: 'https://gitlab.example/owner/repo/merge_requests/17',
					head_branch: 'proposal-branch',
					head_commit: 'abc123',
				},
			},
			isPending: false,
			mutate: vi.fn(),
		});
		const assign = vi.fn();
		vi.stubGlobal('location', { ...window.location, assign });
		vi.spyOn(window, 'open').mockReturnValue(null);
		render(<ChangeRequestActions {...props} provider="gitlab" />);

		await user.click(screen.getByRole('button', { name: 'View MR' }));

		expect(assign).toHaveBeenCalledExactlyOnceWith(
			'https://gitlab.example/owner/repo/merge_requests/17',
		);
	});
});
