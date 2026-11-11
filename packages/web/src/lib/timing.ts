// Real-time waits scheduled by the UI. src/test/setup.ts mocks this module with
// millisecond values so tests never sit through production polling or debouncing.
export const CONVERSATION_POLL_MS = 1500;
export const CHAT_UI_THROTTLE_MS = 80;
export const DEBOUNCE_MS = 200;
export const SEARCH_SUBMIT_DELAY_MS = 500;
