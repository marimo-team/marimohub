// jest-dom matchers (toBeInTheDocument, toHaveClass, …) for the vitest `expect`.
// The runtime registration happens in `setup.ts` via
// `import '@testing-library/jest-dom/vitest'`; this file makes the TYPES visible
// to tsc by augmenting the `vitest` Assertion interface explicitly.
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
	interface Assertion<T = unknown> extends TestingLibraryMatchers<unknown, T> {}
	interface AsymmetricMatchersContaining extends TestingLibraryMatchers<unknown, unknown> {}
}
