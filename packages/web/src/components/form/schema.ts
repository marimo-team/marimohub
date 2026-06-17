import { z } from 'zod';

/**
 * A trimmed, non-empty text field whose "required" message names the field, e.g.
 * `requiredText('Repository')` → "Repository is required". Chain further checks
 * (`.regex`, `.endsWith`, …) for format rules with their own messages.
 */
export function requiredText(label: string) {
	return z.string().trim().min(1, `${label} is required`);
}

/** An optional free-text field (may be empty). */
export function optionalText() {
	return z.string();
}
