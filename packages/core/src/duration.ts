// --- Branded duration types ---
//
// `Millis` and `Seconds` are nominal `number`s, the same convention as the
// branded ids in `ids.ts`. Both stay assignable TO `number` (so
// `setTimeout(fn, ms)` and existing numeric options keep working), but a plain
// `number` — or the other unit — is not assignable to them.
//
// Adoption rule: brand a field when it crosses a package boundary carrying a
// unit, or when the enclosing code converts between units. Leaf option bags
// consumed in a single unit keep `number` with a unit-suffixed name
// (`timeoutMs`); branded values still flow into them. Never write
// `Millis | number` in a signature — it defeats the brand.
//
// Arithmetic between branded values degrades to `number` by design; re-brand
// with `Millis.of(...)` / `Seconds.of(...)` only where the result must stay
// typed.

export type Millis = number & { __brand: 'Millis' };
export type Seconds = number & { __brand: 'Seconds' };

export const Millis = {
	of: (n: number): Millis => n as Millis,
	seconds: (n: number): Millis => (n * 1000) as Millis,
	minutes: (n: number): Millis => (n * 60 * 1000) as Millis,
	hours: (n: number): Millis => (n * 60 * 60 * 1000) as Millis,
	days: (n: number): Millis => (n * 24 * 60 * 60 * 1000) as Millis,
	/** Floors, matching JWT epoch math (`Math.floor(Date.now() / 1000)`). */
	toSeconds: (ms: Millis): Seconds => Math.floor(ms / 1000) as Seconds,
};

export const Seconds = {
	of: (n: number): Seconds => n as Seconds,
	minutes: (n: number): Seconds => (n * 60) as Seconds,
	hours: (n: number): Seconds => (n * 60 * 60) as Seconds,
	toMillis: (s: Seconds): Millis => (s * 1000) as Millis,
};

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
