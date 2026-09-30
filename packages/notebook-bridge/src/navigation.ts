import { AppNavigation } from './protocol';
import { notebookQueryParams } from './query';

export function appNavigation(href: string, appBaseUrl: string, excludedKeys: readonly string[]) {
	const relative = href.startsWith(appBaseUrl) ? `app/${href.slice(appBaseUrl.length)}` : href;
	const match = /^\/?app\/([^?#]+)(\?[^#]*)?(#.*)?(?![\s\S])/.exec(relative);
	if (!match) return;
	const parsed = AppNavigation.safeParse({
		slug: match[1],
		entries: [...new URLSearchParams(match[2])],
		hash: match[3] ?? '',
	});
	if (!parsed.success) return;
	return { ...parsed.data, entries: [...notebookQueryParams(parsed.data.entries, excludedKeys)] };
}

export function appNavigationHref(destination: AppNavigation, base = '/app/'): string {
	const query = new URLSearchParams(destination.entries).toString();
	return `${base}${destination.slug}${query ? `?${query}` : ''}${destination.hash}`;
}

export function observeAppLinks(
	win: Window,
	appBaseUrl: string,
	excludedKeys: readonly string[],
	navigate: (destination: AppNavigation) => void,
) {
	const doc = win.document;
	const originals = new WeakMap<HTMLAnchorElement, { original: string; rewritten: string }>();
	const restoreAnchor = (anchor: HTMLAnchorElement) => {
		const previous = originals.get(anchor);
		if (previous && anchor.getAttribute('href') === previous.rewritten)
			anchor.setAttribute('href', previous.original);
		originals.delete(anchor);
	};
	const rewrite = (anchor: HTMLAnchorElement) => {
		if (anchor.localName !== 'a' || anchor.namespaceURI !== 'http://www.w3.org/1999/xhtml') return;
		if (anchor.hasAttribute('download')) {
			restoreAnchor(anchor);
			return;
		}
		const href = anchor.getAttribute('href');
		if (href === null) return;
		const destination = appNavigation(href, appBaseUrl, excludedKeys);
		if (!destination) return;
		const rewritten = appNavigationHref(destination, appBaseUrl);
		if (href !== rewritten) {
			originals.set(anchor, { original: href, rewritten });
			anchor.setAttribute('href', rewritten);
		}
	};
	let disposed = false;
	const observers = new Map<Document | ShadowRoot, MutationObserver>();
	const restore = (root: ParentNode) => {
		for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href]')) restoreAnchor(anchor);
	};
	const scan = (root: ParentNode) => {
		for (const element of root.querySelectorAll('*')) visit(element);
	};
	const visit = (element: Element) => {
		if (element.localName === 'a') rewrite(element as HTMLAnchorElement);
		if (element.shadowRoot) observe(element.shadowRoot);
	};
	const observe = (root: Document | ShadowRoot) => {
		if (disposed || observers.has(root)) return;
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				for (const node of record.removedNodes) {
					if (node.nodeType !== 1 || node.isConnected) continue;
					const element = node as Element;
					if (element.localName === 'a') restoreAnchor(element as HTMLAnchorElement);
					restore(element);
				}
				if (record.type === 'attributes' && record.target.isConnected)
					rewrite(record.target as HTMLAnchorElement);
				for (const node of record.addedNodes) {
					if (node.nodeType !== 1 || !node.isConnected) continue;
					visit(node as Element);
					scan(node as Element);
				}
			}
			for (const [observed, subscription] of observers) {
				if (observed === doc || observed.isConnected) continue;
				subscription.disconnect();
				restore(observed);
				observers.delete(observed);
			}
		});
		observers.set(root, observer);
		scan(root);
		observer.observe(root, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ['href', 'download'],
		});
	};
	// marimo plugins attach open shadow roots, sometimes after their hosts enter the document.
	const prototype = (win as Window & typeof globalThis).Element.prototype;
	const originalAttach = prototype.attachShadow;
	const attach: Element['attachShadow'] = function (this: Element, options) {
		const root = originalAttach.call(this, options);
		if (options.mode === 'open' && this.isConnected) observe(root);
		return root;
	};
	prototype.attachShadow = attach;
	const onClick = (event: MouseEvent) => {
		const anchor = event
			.composedPath()
			.find(
				(node): node is HTMLAnchorElement =>
					(node as Element).localName === 'a' &&
					(node as Element).namespaceURI === 'http://www.w3.org/1999/xhtml',
			);
		if (!anchor || anchor.hasAttribute('download')) return;
		rewrite(anchor);
		if (
			event.defaultPrevented ||
			event.button !== 0 ||
			event.metaKey ||
			event.ctrlKey ||
			event.shiftKey ||
			event.altKey
		)
			return;
		const target = (
			anchor.hasAttribute('target')
				? anchor.target
				: (doc.querySelector<HTMLBaseElement>('base[target]')?.target ?? '')
		).toLowerCase();
		if (target && target !== '_self') return;
		const destination = appNavigation(anchor.getAttribute('href') ?? '', appBaseUrl, excludedKeys);
		if (!destination) return;
		event.preventDefault();
		// Run before framework handlers can navigate the sandbox themselves.
		event.stopImmediatePropagation();
		navigate(destination);
	};
	observe(doc);
	win.addEventListener('click', onClick, true);
	return () => {
		disposed = true;
		win.removeEventListener('click', onClick, true);
		if (prototype.attachShadow === attach) prototype.attachShadow = originalAttach;
		for (const [root, observer] of observers) {
			observer.disconnect();
			restore(root);
		}
		observers.clear();
	};
}
