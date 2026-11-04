import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithClient } from '@/test/render';
import { AssistantMessage } from './AssistantMessage';
import { isInternalHref } from './internalHref';

function renderMessage(content: string) {
	return renderWithClient(<AssistantMessage content={content} />, {
		route: '/projects/sales/chat',
	});
}

describe('AssistantMessage', () => {
	it('renders semantic lists, code blocks, and tables', () => {
		const { container } = renderMessage(
			'## Findings\n\n- Missing IDs\n- Duplicate rows\n\n```python\nprint("sales")\n```\n\n| Column | Count |\n| --- | --- |\n| id | 12 |',
		);
		expect(screen.getByRole('heading', { name: 'Findings', level: 2 })).toBeInTheDocument();
		expect(screen.getAllByRole('listitem')).toHaveLength(2);
		expect(container.querySelector('pre code')).toHaveTextContent('print("sales")');
		expect(screen.getByRole('table')).toBeInTheDocument();
		expect(screen.getByRole('columnheader', { name: 'Column' })).toBeInTheDocument();
		expect(screen.getByRole('cell', { name: '12' })).toBeInTheDocument();
	});

	it('routes internal notebook links and isolates external links', () => {
		renderMessage(
			'[Open notebook](/projects/sales/notebooks/report) and [Documentation](https://example.com/docs)',
		);
		expect(screen.getByRole('link', { name: 'Open notebook' })).toHaveAttribute(
			'href',
			'/projects/sales/notebooks/report',
		);
		expect(screen.getByRole('link', { name: 'Documentation' })).toHaveAttribute(
			'rel',
			'noopener noreferrer',
		);
		expect(screen.getByRole('link', { name: 'Documentation' })).toHaveAttribute('target', '_blank');
	});

	it('treats protocol-relative links as external', () => {
		expect(isInternalHref('/projects/sales')).toBe(true);
		expect(isInternalHref('//evil.example')).toBe(false);
		expect(isInternalHref('/\\evil.example')).toBe(false);
		// Markdown percent-encodes the backslash, so the rendered link stays same-origin.
		renderMessage('[x](/\\evil.example)');
		expect(screen.getByRole('link', { name: 'x' })).toHaveAttribute('href', '/%5Cevil.example');
	});

	it('uses default URL sanitization to block JavaScript links', () => {
		const { container } = renderMessage('[Unsafe](javascript:alert%281%29)');
		expect(screen.getByText('Unsafe')).toBeInTheDocument();
		expect(screen.queryByRole('link')).not.toBeInTheDocument();
		expect(container.querySelector('[href^="javascript:"]')).toBeNull();
	});

	it('does not render raw HTML or load embedded images', () => {
		const { container } = renderMessage(
			'<script>alert("unsafe")</script>\n\n<img src="https://example.com/tracker" onerror="alert(1)">\n\n![Tracking pixel](https://example.com/pixel?private=value)\n\nSafe text',
		);
		expect(screen.getByText('Safe text')).toBeInTheDocument();
		expect(container.querySelector('script')).toBeNull();
		expect(container.querySelector('img')).toBeNull();
		expect(container.querySelector('[onerror]')).toBeNull();
	});
});
