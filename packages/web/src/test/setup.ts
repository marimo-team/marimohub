import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Production waits (polling, debouncing, stream throttling) would otherwise be paid
// in real time by every test that types or awaits a saved record. Files that assert
// the real durations with fake timers call `vi.unmock('@/lib/timing')`.
vi.mock('@/lib/timing', () => ({
	CONVERSATION_POLL_MS: 20,
	CHAT_UI_THROTTLE_MS: 1,
	DEBOUNCE_MS: 5,
	SEARCH_SUBMIT_DELAY_MS: 5,
}));

let consoleWarn: ReturnType<typeof vi.spyOn>;

const REACT_ARIA_WARNING =
	/<Focusable> child must have an interactive ARIA role|If you do not provide a visible label/;

beforeEach(() => {
	consoleWarn = vi.spyOn(console, 'warn');
});

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
	const warnings = consoleWarn.mock.calls
		.map((args: unknown[]) => args.map(String).join(' '))
		.filter((warning: string) => REACT_ARIA_WARNING.test(warning));
	consoleWarn.mockRestore();
	if (warnings.length > 0) {
		throw new Error(`Unexpected console warning(s):\n${warnings.join('\n')}`);
	}
});
