import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SqlReadinessChecklist } from './SqlReadinessChecklist';

const check = (label: string, field: string, ready = false) => ({
	id: label.toLowerCase().replaceAll(' ', '-'),
	label,
	field,
	ready,
	reason: `${label} is required`,
});

describe('SqlReadinessChecklist', () => {
	it('collapses the server-provided checks behind their readiness summary', async () => {
		const user = userEvent.setup();
		render(
			createElement(SqlReadinessChecklist, {
				checks: [
					check('Set access delegation to none', 'access_delegation'),
					check('Ready', 'uri', true),
				],
				isPending: false,
				isError: false,
			}),
		);

		expect(
			screen.getByText(
				'1 of 2 configuration checks pass. Expand to review and edit failing checks.',
			),
		).toBeTruthy();
		const disclosure = screen.getByText('Run SQL readiness').closest('details');
		expect(disclosure).not.toHaveAttribute('open');

		await user.click(screen.getByText('Run SQL readiness').closest('summary')!);

		expect(disclosure).toHaveAttribute('open');
		expect(screen.getByRole('button', { name: /Set access delegation to none/ })).toHaveAttribute(
			'aria-controls',
			'integration-field-access_delegation',
		);
	});

	it('maps header and extra-property blockers to separate fields', async () => {
		const user = userEvent.setup();
		render(
			createElement(SqlReadinessChecklist, {
				checks: [
					check('Remove custom headers', 'headers'),
					check('Remove extra properties', 'extra_properties'),
				],
				isPending: false,
				isError: false,
			}),
		);
		await user.click(screen.getByText('Run SQL readiness').closest('summary')!);

		expect(screen.getByRole('button', { name: /Remove custom headers/ })).toHaveAttribute(
			'aria-controls',
			'integration-field-headers',
		);
		expect(screen.getByRole('button', { name: /Remove extra properties/ })).toHaveAttribute(
			'aria-controls',
			'integration-field-extra_properties',
		);
	});
});
