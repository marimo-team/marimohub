import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Bot, Code2, FileCode2 } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { ApplicationTabs } from './ApplicationTabs';
import type { ApplicationTabItem } from './ApplicationTabs';

function applicationTabs(): ApplicationTabItem[] {
	return [
		{
			id: 'notebook',
			label: 'Notebook',
			icon: <FileCode2 />,
			panel: <iframe src="https://notebook.example/" title="Notebook frame" />,
			browserUrl: 'https://notebook.example/',
		},
		{
			id: 'vscode',
			label: 'VS Code',
			icon: <Code2 />,
			panel: <iframe src="https://vscode.example/" title="VS Code frame" />,
			browserUrl: 'https://vscode.example/',
			close: {
				title: 'Close VS Code?',
				description: 'Unsaved editor UI state will be lost.',
				confirmLabel: 'Close VS Code',
				pendingLabel: 'Closing VS Code...',
			},
		},
		{
			id: 'opencode',
			label: 'OpenCode',
			icon: <Bot />,
			panel: <iframe src="https://opencode.example/" title="OpenCode frame" />,
		},
	];
}

describe('ApplicationTabs', () => {
	it('hides its tab bar until a second application is present', () => {
		const { rerender } = render(
			<ApplicationTabs
				ariaLabel="Workspace applications"
				tabs={applicationTabs().slice(0, 1)}
				hideTabListWhenSingle
			/>,
		);

		expect(screen.queryByRole('tablist', { name: 'Workspace applications' })).toBeNull();
		rerender(
			<ApplicationTabs
				ariaLabel="Workspace applications"
				tabs={applicationTabs().slice(0, 2)}
				hideTabListWhenSingle
			/>,
		);
		expect(screen.getByRole('tablist', { name: 'Workspace applications' })).toBeVisible();
	});

	it('keeps every panel mounted while the selection changes', async () => {
		const user = userEvent.setup();
		render(
			<ApplicationTabs
				ariaLabel="Workspace applications"
				tabs={applicationTabs()}
				defaultSelectedKey="notebook"
			/>,
		);

		const notebookFrame = screen.getByTitle('Notebook frame');
		const vscodeFrame = screen.getByTitle('VS Code frame');
		await user.click(screen.getByRole('tab', { name: /VS Code/ }));

		expect(screen.getByTitle('Notebook frame')).toBe(notebookFrame);
		expect(screen.getByTitle('VS Code frame')).toBe(vscodeFrame);
		expect(vscodeFrame.closest('[role="tabpanel"]')).not.toHaveAttribute('inert');
		expect(notebookFrame.closest('[role="tabpanel"]')).toHaveAttribute('inert');
	});

	it('shows at most one secondary panel and never remounts an iframe', async () => {
		const user = userEvent.setup();
		const onSplitKeyChange = vi.fn();
		render(
			<ApplicationTabs
				ariaLabel="Workspace applications"
				tabs={applicationTabs()}
				defaultSelectedKey="notebook"
				onSplitKeyChange={onSplitKeyChange}
			/>,
		);

		const notebookFrame = screen.getByTitle('Notebook frame');
		const vscodeFrame = screen.getByTitle('VS Code frame');
		const opencodeFrame = screen.getByTitle('OpenCode frame');
		const panelParents = new Map([
			[notebookFrame, notebookFrame.parentElement],
			[vscodeFrame, vscodeFrame.parentElement],
			[opencodeFrame, opencodeFrame.parentElement],
		]);

		await user.click(screen.getByRole('button', { name: 'Open OpenCode to the side' }));
		expect(screen.getByRole('separator', { name: 'Resize split view' })).toBeInTheDocument();
		expect(notebookFrame.closest('[role="tabpanel"]')).not.toHaveAttribute('inert');
		expect(opencodeFrame.closest('[role="tabpanel"]')).not.toHaveAttribute('inert');
		expect(vscodeFrame.closest('[role="tabpanel"]')).toHaveAttribute('inert');

		await user.click(screen.getByRole('button', { name: 'Open VS Code to the side' }));
		expect(notebookFrame.closest('[role="tabpanel"]')).not.toHaveAttribute('inert');
		expect(vscodeFrame.closest('[role="tabpanel"]')).not.toHaveAttribute('inert');
		expect(opencodeFrame.closest('[role="tabpanel"]')).toHaveAttribute('inert');
		expect(screen.getAllByRole('tabpanel')).toHaveLength(2);

		expect(screen.getByTitle('Notebook frame')).toBe(notebookFrame);
		expect(screen.getByTitle('VS Code frame')).toBe(vscodeFrame);
		expect(screen.getByTitle('OpenCode frame')).toBe(opencodeFrame);
		for (const [frame, parent] of panelParents) expect(frame.parentElement).toBe(parent);

		await user.click(screen.getByRole('button', { name: 'Close VS Code split view' }));
		expect(screen.queryByRole('separator', { name: 'Resize split view' })).toBeNull();
		expect(vscodeFrame.closest('[role="tabpanel"]')).toHaveAttribute('inert');
		expect(onSplitKeyChange.mock.calls).toEqual([['opencode'], ['vscode'], [null]]);
	});

	it('swaps the primary and secondary panels without moving their nodes', async () => {
		const user = userEvent.setup();
		render(
			<ApplicationTabs
				ariaLabel="Workspace applications"
				tabs={applicationTabs()}
				defaultSelectedKey="notebook"
				defaultSplitKey="opencode"
			/>,
		);

		const notebookFrame = screen.getByTitle('Notebook frame');
		const opencodeFrame = screen.getByTitle('OpenCode frame');
		await user.click(screen.getByRole('tab', { name: /OpenCode/ }));

		expect(screen.getByRole('tab', { name: /OpenCode/ })).toHaveAttribute('aria-selected', 'true');
		expect(notebookFrame.closest('[role="tabpanel"]')).not.toHaveAttribute('inert');
		expect(opencodeFrame.closest('[role="tabpanel"]')).not.toHaveAttribute('inert');
		expect(screen.getByTitle('Notebook frame')).toBe(notebookFrame);
		expect(screen.getByTitle('OpenCode frame')).toBe(opencodeFrame);
	});

	it('resizes the split by keyboard and pointer within safe bounds', () => {
		const onSplitSizeChange = vi.fn();
		render(
			<ApplicationTabs
				ariaLabel="Workspace applications"
				tabs={applicationTabs()}
				defaultSelectedKey="notebook"
				defaultSplitKey="opencode"
				onSplitSizeChange={onSplitSizeChange}
			/>,
		);

		const separator = screen.getByRole('separator', { name: 'Resize split view' });
		fireEvent.keyDown(separator, { key: 'ArrowRight' });
		expect(separator).toHaveAttribute('aria-valuenow', '52');

		fireEvent.keyDown(separator, { key: 'Home' });
		expect(separator).toHaveAttribute('aria-valuenow', '20');
		fireEvent.keyDown(separator, { key: 'ArrowLeft' });
		expect(separator).toHaveAttribute('aria-valuenow', '20');

		const panels = screen.getByTitle('Notebook frame').closest('[data-application-panels]');
		expect(panels).not.toBeNull();
		vi.spyOn(panels as HTMLElement, 'getBoundingClientRect').mockReturnValue({
			left: 100,
			right: 1100,
			top: 0,
			bottom: 600,
			width: 1000,
			height: 600,
			x: 100,
			y: 0,
			toJSON: () => null,
		});
		fireEvent.pointerDown(separator, { pointerId: 1, clientX: 300 });
		fireEvent.pointerMove(separator, { pointerId: 1, clientX: 700 });
		fireEvent.pointerUp(separator, { pointerId: 1 });
		expect(separator).toHaveAttribute('aria-valuenow', '60');

		fireEvent.keyDown(separator, { key: 'End' });
		fireEvent.keyDown(separator, { key: 'ArrowRight' });
		expect(separator).toHaveAttribute('aria-valuenow', '80');
		expect(onSplitSizeChange).toHaveBeenLastCalledWith(80);
	});

	it('does not move panel nodes when the visible tab order changes', () => {
		const tabs = applicationTabs();
		const { rerender } = render(
			<ApplicationTabs
				ariaLabel="Workspace applications"
				tabs={tabs}
				order={['notebook', 'vscode', 'opencode']}
			/>,
		);
		const originalFrames = new Map(
			['Notebook frame', 'VS Code frame', 'OpenCode frame'].map((title) => [
				title,
				screen.getByTitle(title),
			]),
		);

		rerender(
			<ApplicationTabs
				ariaLabel="Workspace applications"
				tabs={[tabs[2], tabs[0], tabs[1]]}
				order={['opencode', 'notebook', 'vscode']}
			/>,
		);

		expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
			'OpenCode',
			'Notebook',
			'VS Code',
		]);
		for (const [title, frame] of originalFrames) {
			expect(screen.getByTitle(title)).toBe(frame);
		}
	});

	it('reorders tabs with the keyboard shortcut on the drag handle', () => {
		const onOrderChange = vi.fn();
		render(
			<ApplicationTabs
				ariaLabel="Workspace applications"
				tabs={applicationTabs()}
				onOrderChange={onOrderChange}
			/>,
		);

		fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Notebook' }), {
			key: 'ArrowRight',
			altKey: true,
			shiftKey: true,
		});

		expect(onOrderChange).toHaveBeenCalledWith(['vscode', 'notebook', 'opencode']);
		expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
			'VS Code',
			'Notebook',
			'OpenCode',
		]);
	});

	it('opens a panel URL directly in a new browser tab', async () => {
		const user = userEvent.setup();
		const open = vi.spyOn(window, 'open').mockReturnValue(null);
		render(<ApplicationTabs ariaLabel="Workspace applications" tabs={applicationTabs()} />);

		await user.click(screen.getByRole('button', { name: 'Open Notebook in a new browser tab' }));

		expect(open).toHaveBeenCalledWith('https://notebook.example/', '_blank', 'noopener,noreferrer');
	});

	it('confirms and awaits a close before dismissing the dialog', async () => {
		const user = userEvent.setup();
		let finishClose!: () => void;
		const onClose = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishClose = resolve;
				}),
		);
		render(
			<ApplicationTabs
				ariaLabel="Workspace applications"
				tabs={applicationTabs()}
				onClose={onClose}
			/>,
		);

		await user.click(screen.getByRole('button', { name: 'Close VS Code' }));
		expect(screen.getByRole('dialog')).toHaveTextContent('Unsaved editor UI state will be lost.');
		expect(onClose).not.toHaveBeenCalled();

		await user.click(screen.getByRole('button', { name: 'Close VS Code' }));
		expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ id: 'vscode' }));
		expect(screen.getByText('Closing VS Code...')).toBeInTheDocument();

		await act(async () => finishClose());
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	});
});
