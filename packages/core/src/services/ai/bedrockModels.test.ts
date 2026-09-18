import { describe, expect, it } from 'vitest';
import { isAnthropicBedrockModel } from './bedrockModels';

describe('isAnthropicBedrockModel', () => {
	it.each([
		'anthropic.claude-opus-4-7',
		'eu.anthropic.claude-opus-4-7',
		'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
		'global.anthropic.claude-sonnet-4-5',
	])('matches the Anthropic id %s', (model) => {
		expect(isAnthropicBedrockModel(model)).toBe(true);
	});

	it.each([
		'gpt-4o-mini',
		'openai.gpt-oss-120b-1:0',
		'eu.amazon.nova-pro-v1:0',
		'amazon.nova-lite-v1:0',
		'cohere.command-r-plus-v1:0',
		// A substring match must not leak: the provider segment is `anthropic.`,
		// not any occurrence of the word.
		'my-anthropic-clone',
	])('does not match the non-Anthropic id %s', (model) => {
		expect(isAnthropicBedrockModel(model)).toBe(false);
	});
});
