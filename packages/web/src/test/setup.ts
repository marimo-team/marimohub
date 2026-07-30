import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

if (!HTMLElement.prototype.setPointerCapture) {
	Object.defineProperties(HTMLElement.prototype, {
		setPointerCapture: { value: () => {}, configurable: true },
		releasePointerCapture: { value: () => {}, configurable: true },
		hasPointerCapture: { value: () => false, configurable: true },
	});
}

// Unmount anything rendered between tests so the jsdom document stays clean.
afterEach(() => {
	cleanup();
});
