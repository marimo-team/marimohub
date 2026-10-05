import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SourceRefInput } from './SourceRefInput';

const queries = vi.hoisted(() => ({
	branches: {
		data: [] as { value: string; label: string; commit: string }[],
		isFetching: false,
		isError: false,
	},
}));
vi.mock('@/api/sourceControl', () => ({
	useSourceBranchesQuery: () => queries.branches,
	useSourceCommitsQuery: () => queries.branches,
}));
function Harness({ submit, type = 'branch' }: { submit: () => void; type?: 'branch' | 'commit' }) {
	const [value, setValue] = useState('');
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<SourceRefInput pid="p" nid="n" type={type} value={value} onChange={setValue} />
			<button type="submit">Create</button>
		</form>
	);
}
describe('SourceRefInput', () => {
	it('keeps canonical selection after blur without submitting', async () => {
		queries.branches = {
			data: [{ value: 'feature/chart', label: 'Chart prototype', commit: 'a'.repeat(40) }],
			isFetching: false,
			isError: false,
		};
		const submit = vi.fn();
		const user = userEvent.setup();
		render(<Harness submit={submit} />);
		await user.type(screen.getByRole('combobox'), 'chart');
		await user.click(screen.getByRole('option'));
		await user.tab();
		expect(screen.getByRole('combobox')).toHaveValue('feature/chart');
		expect(submit).not.toHaveBeenCalled();
	});
	it('shows commit-message matches and retains the full SHA after selection', async () => {
		const commit = 'a'.repeat(40);
		queries.branches = {
			data: [{ value: commit, label: 'Fix chart legend', commit }],
			isFetching: false,
			isError: false,
		};
		const user = userEvent.setup();
		render(<Harness type="commit" submit={() => {}} />);
		await user.type(screen.getByRole('combobox'), 'legend');
		await user.click(screen.getByRole('option', { name: /Fix chart legend/ }));
		await user.tab();
		expect(screen.getByRole('combobox')).toHaveValue(commit);
	});
	it('guides commit inputs to enter a full SHA when there are no suggestions', async () => {
		queries.branches = { data: [], isFetching: false, isError: false };
		const user = userEvent.setup();
		render(<SourceRefInput pid="p" nid="n" type="commit" value="abc" onChange={() => {}} />);
		await user.click(screen.getByRole('combobox'));
		await user.keyboard('{ArrowDown}');
		expect(screen.getByText('No suggestions. Enter a full commit SHA.')).toBeInTheDocument();
	});
	it('retains a manual ref through pending, error, empty, and late suggestions', async () => {
		queries.branches = { data: [], isFetching: true, isError: false };
		const user = userEvent.setup();
		const submit = vi.fn();
		const view = render(<Harness submit={submit} />);
		await user.type(screen.getByRole('combobox'), 'manual/new-branch');
		queries.branches = { data: [], isFetching: false, isError: true };
		view.rerender(<Harness submit={submit} />);
		await user.tab();
		expect(screen.getByRole('combobox')).toHaveValue('manual/new-branch');
		queries.branches = { data: [], isFetching: false, isError: false };
		view.rerender(<Harness submit={submit} />);
		await user.click(screen.getByRole('combobox'));
		// Reopen suggestions with an edit while preserving the manually entered ref.
		await user.keyboard('{End} {Backspace}');
		expect(screen.getByText('No suggestions. Enter a branch name.')).toBeInTheDocument();
		expect(screen.getByRole('combobox')).toHaveValue('manual/new-branch');
		queries.branches = {
			data: [{ value: 'old', label: 'Old result', commit: 'b'.repeat(40) }],
			isFetching: false,
			isError: false,
		};
		view.rerender(<Harness submit={submit} />);
		expect(screen.getByRole('combobox')).toHaveValue('manual/new-branch');
		await user.tab();
		await user.click(screen.getByRole('button', { name: 'Create' }));
		expect(submit).toHaveBeenCalledOnce();
	});
});
