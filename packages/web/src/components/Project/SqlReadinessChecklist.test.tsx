import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { setupUser } from '@/test/render';
import { schemaFieldId } from '@/components/form/schema-form';
import { SqlReadinessChecklist } from './SqlReadinessChecklist';

describe('SQL readiness guidance', () => {
	it('shows a failed check’s explanation and takes the user to its field', async () => {
		const user = setupUser();
		render(
			<>
				<SqlReadinessChecklist
					isPending={false}
					isError={false}
					checks={[
						{
							id: 's3-endpoint',
							label: 'Set an explicit S3 endpoint',
							ready: false,
							field: 'endpoint_url',
							reason: 'Set Endpoint URL to your storage service URL, without a bucket path.',
						},
					]}
				/>
				<details>
					<summary>Storage</summary>
					<div id={schemaFieldId('endpoint_url')}>
						<input aria-label="Endpoint URL" />
					</div>
				</details>
			</>,
		);
		await user.click(screen.getByText('Run SQL readiness'));
		expect(
			screen.getByText('Set Endpoint URL to your storage service URL, without a bucket path.'),
		).toBeVisible();
		await user.click(screen.getByRole('button', { name: /Set an explicit S3 endpoint/ }));
		await waitFor(() =>
			expect(screen.getByRole('textbox', { name: 'Endpoint URL' })).toHaveFocus(),
		);
	});

	it('does not show failure guidance for a passing check', async () => {
		const user = setupUser();
		render(
			<SqlReadinessChecklist
				isPending={false}
				isError={false}
				checks={[
					{
						id: 's3-endpoint',
						label: 'Set an explicit S3 endpoint',
						ready: true,
						field: 'endpoint_url',
						reason: 'Failure guidance',
					},
				]}
			/>,
		);
		await user.click(screen.getByText('Run SQL readiness'));
		expect(screen.getByRole('button', { name: 'Set an explicit S3 endpoint' })).toBeVisible();
		expect(screen.queryByText('Failure guidance')).not.toBeInTheDocument();
	});
});
