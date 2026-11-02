import { expect, it } from 'vitest';
import { htmlText } from './text';
import { savedOutputText } from './NotebookSource';

it('extracts visible text while excluding scripts, styles, attributes, and hidden elements', () => {
	expect(
		htmlText(
			'<div>Revenue &amp; profit</div><script>secret</script><style>secret</style><div hidden>secret</div><a href="secret">Report</a>',
		),
	).toBe('Revenue & profit Report');
});
it('indexes saved data outputs without logs, source cells, or binary output', () => {
	const session = {
		cells: [
			{
				code: 'private code',
				console: 'private log',
				outputs: [
					{ type: 'data', data: { 'text/plain': 'Revenue 42', 'text/html': '<b>duplicate</b>' } },
					{
						type: 'data',
						data: { 'text/html': '<b>Margin &gt; 10</b><script>private script</script>' },
					},
					{ type: 'data', data: { 'image/png': 'private binary' } },
					{ type: 'console', data: { 'text/plain': 'private log' } },
				],
			},
		],
	};
	expect(savedOutputText(JSON.stringify(session))).toBe('Revenue 42\nMargin > 10');
});
