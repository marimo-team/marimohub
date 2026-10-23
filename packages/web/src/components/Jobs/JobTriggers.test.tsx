import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { jsonError, jsonOk, renderWithClient } from '@/test/render';
import type { Job } from '@/types';
import { ChainPicker, WebhookTriggerPanel } from './JobTriggers';

const job: Job = {
	id: 'job-1',
	notebook_id: 'nb-1',
	project_id: 'proj-1',
	name: 'Source',
	enabled: true,
	concurrency_policy: 'forbid',
	created_by: 'u',
	created_at: '2026-10-21T00:00:00Z',
	updated_at: '2026-10-21T00:00:00Z',
};
afterEach(() => vi.unstubAllGlobals());

describe('Job triggers UI', () => {
	it('shows a PAT-authenticated trigger URL without a separate token flow', () => {
		renderWithClient(<WebhookTriggerPanel projectId="proj-1" notebookId="nb-1" job={job} />);
		expect(screen.getByLabelText('Trigger URL')).toHaveValue(
			`${window.location.origin}/api/v1/projects/proj-1/notebooks/nb-1/jobs/job-1/trigger`,
		);
		expect(screen.getByText(/personal access token/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Copy trigger url' })).toBeInTheDocument();
		expect(screen.queryByLabelText('Trigger token')).not.toBeInTheDocument();
	});

	it('resolves collapsed targets by notebook and shares requests for targets in the same notebook', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input instanceof Request ? input.url : String(input);
			if (!url.includes('/jobs')) {
				return jsonOk({ items: [{ id: 'nb-2', title: 'Other notebook' }], next_cursor: null });
			}
			const name = url.includes('/notebooks/nb-2/') ? 'Other notebook job' : 'First notebook job';
			return jsonOk({ items: [{ ...job, id: 'shared-id', name }], next_cursor: null });
		});
		vi.stubGlobal('fetch', fetchMock);
		renderWithClient(
			<ChainPicker
				projectId="proj-1"
				notebookId="nb-1"
				jobId="job-1"
				value={{
					on_success: [
						{ notebook_id: 'nb-1', job_id: 'shared-id' },
						{ notebook_id: 'nb-2', job_id: 'shared-id' },
					],
					on_failure: [{ notebook_id: 'nb-2', job_id: 'shared-id' }],
				}}
				onChange={vi.fn()}
			/>,
		);
		expect(await screen.findByText('Success: First notebook job')).toBeInTheDocument();
		expect(await screen.findByText('Success: Other notebook job')).toBeInTheDocument();
		expect(await screen.findByText('Failure: Other notebook job')).toBeInTheDocument();
		expect(screen.queryByLabelText('Target notebook')).not.toBeInTheDocument();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const user = userEvent.setup();
		await user.click(screen.getByRole('button', { name: 'Choose downstream jobs' }));
		await screen.findByRole('option', { name: 'Other notebook' });
		await user.selectOptions(screen.getByLabelText('Target notebook'), 'nb-2');
		expect(screen.getByText('Success: First notebook job')).toBeInTheDocument();
		expect(screen.getByText('Success: Other notebook job')).toBeInTheDocument();
	});

	it.each(['missing', 'inaccessible'])(
		'keeps %s targets identifiable and removable',
		async (state) => {
			vi.stubGlobal(
				'fetch',
				vi.fn(async () =>
					state === 'missing'
						? jsonOk({ items: [], next_cursor: null })
						: jsonError('FORBIDDEN', 'Access denied', 403),
				),
			);
			const onChange = vi.fn();
			const user = userEvent.setup();
			renderWithClient(
				<ChainPicker
					projectId="proj-1"
					notebookId="nb-1"
					value={{ on_success: [{ notebook_id: 'nb-2', job_id: 'missing-job' }] }}
					onChange={onChange}
				/>,
			);
			expect(screen.getByText('Success: missing-job')).toBeInTheDocument();
			await user.click(
				screen.getByRole('button', { name: 'Remove on_success target missing-job' }),
			);
			expect(onChange).toHaveBeenCalledWith({ on_success: [] });
		},
	);

	it('follows the current notebook by default and keeps an explicit target selection', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = input instanceof Request ? input.url : String(input);
				if (url.includes('/jobs')) {
					const notebookId = url.includes('/notebooks/nb-2/') ? 'nb-2' : 'nb-1';
					return jsonOk({
						items: [
							{
								...job,
								id: `target-${notebookId}`,
								name: `Target in ${notebookId}`,
								notebook_id: notebookId,
							},
						],
						next_cursor: null,
					});
				}
				return jsonOk({
					items: [
						{ id: 'nb-1', title: 'First notebook' },
						{ id: 'nb-2', title: 'Second notebook' },
					],
					next_cursor: null,
				});
			}),
		);
		const onChange = vi.fn();
		const picker = (notebookId: string) => (
			<ChainPicker
				projectId="proj-1"
				notebookId={notebookId}
				jobId="job-1"
				value={{}}
				onChange={onChange}
			/>
		);
		const { rerender } = renderWithClient(picker('nb-1'));
		const user = userEvent.setup();
		await user.click(screen.getByRole('button', { name: 'Choose downstream jobs' }));
		await screen.findByRole('option', { name: 'Second notebook' });
		expect(screen.getByLabelText('Target notebook')).toHaveValue('nb-1');
		rerender(picker('nb-2'));
		expect(screen.getByLabelText('Target notebook')).toHaveValue('nb-2');
		await waitFor(() => expect(screen.getByLabelText('After success')).toBeEnabled());
		await user.selectOptions(screen.getByLabelText('After success'), 'target-nb-2');
		expect(onChange).toHaveBeenLastCalledWith({
			on_success: [{ notebook_id: 'nb-2', job_id: 'target-nb-2' }],
		});
		await user.selectOptions(screen.getByLabelText('Target notebook'), 'nb-1');
		rerender(picker('nb-3'));
		expect(screen.getByLabelText('Target notebook')).toHaveValue('nb-1');
		await user.selectOptions(screen.getByLabelText('Target notebook'), 'nb-3');
		rerender(picker('nb-1'));
		expect(screen.getByLabelText('Target notebook')).toHaveValue('nb-1');
	});

	it('selects same-project targets, excludes the source, and removes a target', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes('/jobs'))
					return jsonOk({
						items: [job, { ...job, id: 'job-2', name: 'Target' }],
						next_cursor: null,
					});
				return jsonOk({ items: [{ id: 'nb-1', title: 'Notebook' }], next_cursor: null });
			}),
		);
		const changed = vi.fn();
		function Picker() {
			const [value, setValue] = useState<NonNullable<Job['chain']>>({});
			return (
				<ChainPicker
					projectId="proj-1"
					notebookId="nb-1"
					jobId="job-1"
					value={value}
					onChange={(next) => {
						setValue(next);
						changed(next);
					}}
				/>
			);
		}
		const user = userEvent.setup();
		renderWithClient(<Picker />);
		await user.click(screen.getByRole('button', { name: 'Choose downstream jobs' }));
		await waitFor(() => expect(screen.getByLabelText('After success')).toBeEnabled());
		expect(screen.queryByRole('option', { name: 'Source' })).not.toBeInTheDocument();
		await user.selectOptions(screen.getByLabelText('After success'), 'job-2');
		expect(changed).toHaveBeenLastCalledWith({
			on_success: [{ notebook_id: 'nb-1', job_id: 'job-2' }],
		});
		await user.click(screen.getByRole('button', { name: 'Remove on_success target job-2' }));
		expect(changed).toHaveBeenLastCalledWith({ on_success: [] });
	});
});
