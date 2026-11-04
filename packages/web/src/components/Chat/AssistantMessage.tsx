import Markdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router-dom';

const components: Components = {
	a: ({ children, href }) => {
		if (!href) return <span>{children}</span>;
		if (href.startsWith('/') && !href.startsWith('//')) {
			return <Link to={href}>{children}</Link>;
		}
		return (
			<a href={href} target="_blank" rel="noopener noreferrer">
				{children}
			</a>
		);
	},
	table: ({ children }) => (
		<div className="my-4 max-w-full overflow-x-auto rounded-lg border">
			<table className="w-full border-collapse text-left text-sm">{children}</table>
		</div>
	),
};

export function AssistantMessage({ content }: { content: string }) {
	return (
		<div className="min-w-0 break-words text-sm leading-7 [&_a]:rounded-sm [&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 [&_a]:outline-none [&_a]:focus-visible:ring-2 [&_a]:focus-visible:ring-ring [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted/70 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px] [&_h1]:mb-3 [&_h1]:mt-5 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:font-semibold [&_hr]:my-5 [&_li]:my-1 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-3 [&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:bg-muted/50 [&_pre]:p-4 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_td]:border-t [&_td]:px-3 [&_td]:py-2 [&_th]:bg-muted/50 [&_th]:px-3 [&_th]:py-2 [&_th]:font-semibold [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&>:first-child]:mt-0 [&>:last-child]:mb-0">
			<Markdown
				remarkPlugins={[remarkGfm]}
				components={components}
				skipHtml
				disallowedElements={['img']}
			>
				{content}
			</Markdown>
		</div>
	);
}
