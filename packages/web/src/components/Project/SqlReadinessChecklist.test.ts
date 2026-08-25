import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
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
	it('renders the server-provided readiness result', () => {
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
				'1 of 2 configuration checks pass. Select a failing check to edit its field.',
			),
		).toBeTruthy();
		expect(screen.getByRole('link', { name: /Set access delegation to none/ })).toHaveAttribute(
			'href',
			'#integration-field-access_delegation',
		);
	});

	it('links header and extra-property blockers to separate fields', () => {
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

		expect(screen.getByRole('link', { name: /Remove custom headers/ })).toHaveAttribute(
			'href',
			'#integration-field-headers',
		);
		expect(screen.getByRole('link', { name: /Remove extra properties/ })).toHaveAttribute(
			'href',
			'#integration-field-extra_properties',
		);
	});
});
