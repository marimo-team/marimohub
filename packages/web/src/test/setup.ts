import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount anything rendered between tests so the jsdom document stays clean.
afterEach(() => {
	cleanup();
});
