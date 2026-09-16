import { describe, expect, it } from 'vitest';
import { DeepLinkSlugSchema } from './deepLinkSlug';

describe('DeepLinkSlugSchema', () => {
	it.each([
		'a',
		'0',
		'sales--2026',
		'team/overview',
		'a/0/b-1',
		'a'.repeat(63),
		`a/${'b'.repeat(61)}`,
		Array(32).fill('a').join('/'),
	])('accepts %j', (slug) => {
		expect(DeepLinkSlugSchema.parse(slug)).toBe(slug);
	});

	it.each([
		'',
		'/',
		'/team',
		'team/',
		'team//overview',
		'team///overview',
		'-team/overview',
		'team-/overview',
		'team/-overview',
		'team/overview-',
		'team/-/overview',
		'.',
		'..',
		'../team',
		'team/.',
		'team/..',
		'team/../overview',
		'team/./overview',
		'team/overview.json',
		'team%2Foverview',
		'team/%2e%2e/overview',
		'team/%252e%252e/overview',
		'team\\overview',
		'team?x=1',
		'team#overview',
		'team_overview',
		' team/overview',
		'team/overview ',
		'team/ overview',
		'Team/overview',
		'team/Overview',
		'team/é',
		'team/概览',
		'team/😀',
		'team／overview',
		'team∕overview',
		'team/over\u200bview',
		'team/overview\n',
		'team/overview\r\n',
		'team/overview\u2028',
		'team/overview\u2029',
		'a'.repeat(64),
		`a/${'b'.repeat(62)}`,
		Array(33).fill('a').join('/'),
	])('rejects %j', (slug) => {
		expect(DeepLinkSlugSchema.safeParse(slug).success).toBe(false);
	});

	const forbiddenAscii = Array.from({ length: 128 }, (_, code) => String.fromCharCode(code)).filter(
		(character) => !/[a-z0-9/-]/.test(character),
	);
	it.each(forbiddenAscii)('rejects ASCII character %j anywhere in a slug', (character) => {
		for (const slug of [
			`${character}team/overview`,
			`team/over${character}view`,
			`team/overview${character}`,
		]) {
			expect(DeepLinkSlugSchema.safeParse(slug).success).toBe(false);
		}
	});
});
