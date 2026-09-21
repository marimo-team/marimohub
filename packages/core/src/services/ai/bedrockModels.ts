/**
 * Classify Bedrock model ids. Anthropic Claude models are only reachable through
 * Bedrock's Converse API — the OpenAI-compatible surface 404s them — so the AI
 * proxy routes them to a translating bridge instead of the raw passthrough.
 */

/**
 * True for an Anthropic Bedrock model id. Matches bare ids (`anthropic.…`) and
 * cross-region inference profiles (`eu.anthropic.…`, `us.anthropic.…`,
 * `global.anthropic.…`), where the geo prefix precedes the provider segment.
 */
export function isAnthropicBedrockModel(model: string): boolean {
	return /(^|\.)anthropic\./.test(model);
}
