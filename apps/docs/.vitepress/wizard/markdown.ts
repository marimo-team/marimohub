/**
 * Markdown → HTML for the wizard's Setup section. First-party content only, so
 * `html: false` is safe.
 *
 * `::: tip|warning|info|danger` containers render to the same `custom-block`
 * markup VitePress emits, so callouts look identical in the docs and the wizard.
 */
import MarkdownIt from 'markdown-it';
import container from 'markdown-it-container';

const CONTAINERS = ['tip', 'warning', 'info', 'danger'] as const;

const md = new MarkdownIt({ html: false, linkify: true });

for (const type of CONTAINERS) {
	md.use(container, type, {
		render(tokens: { nesting: number; info: string }[], idx: number) {
			const token = tokens[idx];
			if (token.nesting === 1) {
				const custom = token.info.trim().slice(type.length).trim();
				const title = md.utils.escapeHtml(custom || type.toUpperCase());
				return `<div class="custom-block ${type}"><p class="custom-block-title">${title}</p>\n`;
			}
			return '</div>\n';
		},
	});
}

export function renderMarkdown(src: string): string {
	return md.render(src);
}
