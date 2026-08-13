// uv's recognition rule (verified empirically): a column-0 line that is
// exactly `# /// script` declares metadata; trailing whitespace or indentation
// means none. Block validity is deliberately unchecked — a malformed block
// should fail the launch's `uv export` with uv's own diagnostic, not be
// silently ignored here.
const SCRIPT_TAG = /^# \/\/\/ script\r?$/m;

/** Whether `code` declares a PEP 723 `# /// script` metadata block. */
export function hasInlineScriptMetadata(code: string): boolean {
	return SCRIPT_TAG.test(code);
}
