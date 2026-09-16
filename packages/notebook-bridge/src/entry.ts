import { startNotebookBridge } from './notebook';

const origin = document.currentScript?.getAttribute('data-parent-origin');
if (origin && window.parent !== window) {
	try {
		startNotebookBridge({ parentOrigin: origin });
	} catch {
		/* Unsupported hosts keep native notebook behavior. */
	}
}
