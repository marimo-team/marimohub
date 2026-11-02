import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
const OMIT = new Set([
	'script',
	'style',
	'template',
	'noscript',
	'svg',
	'canvas',
	'iframe',
	'head',
]);
const BLOCK = new Set([
	'div',
	'p',
	'br',
	'li',
	'tr',
	'td',
	'th',
	'section',
	'h1',
	'h2',
	'h3',
	'pre',
	'h4',
	'h5',
	'h6',
	'dt',
	'dd',
	'article',
	'header',
	'footer',
	'main',
	'nav',
	'aside',
	'blockquote',
	'hr',
	'figure',
	'figcaption',
	'ul',
	'ol',
	'dl',
	'table',
	'address',
	'details',
	'summary',
	'fieldset',
	'legend',
]);
export function cleanText(value: string): string {
	return (
		value
			.normalize('NFC')
			// ANSI escape sequences must disappear with their control byte.
			// eslint-disable-next-line no-control-regex
			.replaceAll(/\u001b\[[0-9;]*[A-Za-z]/g, '')
			.replaceAll(/[\p{Cc}\p{Cf}\s]+/gu, ' ')
			.trim()
	);
}
export function htmlText(html: string): string {
	const parts: string[] = [];
	const stack: (DefaultTreeAdapterTypes.Node | string)[] = [parseFragment(html)];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (typeof node === 'string') {
			parts.push(node);
			continue;
		}
		if ('tagName' in node) {
			if (
				OMIT.has(node.tagName) ||
				node.attrs.some(
					(a) =>
						a.name === 'hidden' ||
						(a.name === 'aria-hidden' && a.value === 'true') ||
						(a.name === 'style' &&
							/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!\s*important\s*)?(?:;|$)/i.test(
								a.value.replaceAll(/\/\*[\s\S]*?\*\//g, ''),
							)),
				)
			)
				continue;
			if (BLOCK.has(node.tagName)) {
				parts.push(' ');
				stack.push(' ');
			}
		}
		if ('value' in node) parts.push(node.value);
		if ('childNodes' in node)
			for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
	}
	return cleanText(parts.join(''));
}
