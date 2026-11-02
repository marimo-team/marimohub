import { expect, it, vi } from 'vitest';
import * as parse5 from 'parse5';
import { htmlText } from './text';
import { savedOutputText } from './NotebookSource';

vi.mock('parse5', { spy: true });

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

it('separates block text without splitting inline text', () => {
	expect(
		htmlText(
			'<h4>One</h4><h5>Two</h5><h6>Three</h6><dl><dt>Term</dt><dd>Value</dd></dl><article>Body</article><footer>Foot<b>er</b></footer>',
		),
	).toBe('One Two Three Term Value Body Footer');
});
it('omits inline hidden subtrees but keeps visible inline styles', () => {
	expect(
		htmlText(
			'<p style="DISPLAY: /* hidden */ none !important">secret<b>child</b></p><p style="color:red; visibility: hidden;">secret</p><p style="display:inline;visibility:visible">Shown</p>',
		),
	).toBe('Shown');
});
it('handles wide output trees without exceeding argument limits', () => {
	const count = 150_000;
	// Isolate traversal from the parser's cost for an unusually wide tree.
	const tree = parse5.parseFragment('<span>x</span>');
	tree.childNodes = Array.from({ length: count }, () => tree.childNodes[0]);
	vi.mocked(parse5.parseFragment).mockReturnValueOnce(tree);
	expect(htmlText('')).toBe('x'.repeat(count));
});
