// Vendored & trimmed from @total-typescript/ts-reset (MIT, Matt Pocock).
// https://github.com/mattpocock/ts-reset — see ./README.md
//
// Pulled into every package via `types: ["@marimo-hub/tsconfig/ts-reset"]` in
// `base.json`, so its interface merges apply repo-wide. Only the high-value,
// bug-catching subset is vendored — the "complicated" widening helpers
// (Array.includes / Set.has / Map.has accepting wider literals) are
// intentionally omitted; those loosen types rather than catch bugs.
//
// To disable a single rule, comment out its block. Do not add side-effecting
// code here.

declare namespace TSReset {
	// Falsy members of a union, as removed by `.filter(Boolean)`.
	type NonFalsy<T> = T extends false | 0 | '' | null | undefined | 0n ? never : T;
}

// 1. `JSON.parse` returns `unknown` instead of `any`, forcing callers to
//    validate/narrow parsed data before use.
interface JSON {
	parse(text: string, reviver?: (this: any, key: string, value: any) => any): unknown;
}

// 2. `response.json()` / `request.json()` (the DOM `Body` mixin) return
//    `unknown` instead of `any`, for the same reason as JSON.parse.
interface Body {
	json(): Promise<unknown>;
}

// 3. `.filter(Boolean)` removes falsy members (null/undefined/0/''/false/0n)
//    from the element type, so `(T | undefined)[]` becomes `T[]`.
//    `NoInfer` (built-in since TS 5.4) keeps structural checks on the elements
//    when `.filter(Boolean)` is used inline as an argument.
interface Array<T> {
	filter<S extends T>(predicate: BooleanConstructor, thisArg?: any): TSReset.NonFalsy<NoInfer<S>>[];
}

interface ReadonlyArray<T> {
	filter<S extends T>(predicate: BooleanConstructor, thisArg?: any): TSReset.NonFalsy<NoInfer<S>>[];
}

// 4. `Array.isArray(x)` narrows to `unknown[]` instead of `any[]`, so elements
//    must be narrowed before use rather than silently becoming `any`.
interface ArrayConstructor {
	isArray(arg: any): arg is unknown[];
}
