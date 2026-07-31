import { describe, it, expect } from 'vitest';
import {
	anyRefMatchesSubject,
	emailsEqual,
	foldCase,
	isEmailRef,
	memberRefMatchesSelector,
	memberRefMatchesSubject,
	normalizeEmail,
	refMatchesSubject,
} from './identityMatch';
import type { IdentitySubject } from './identityMatch';
import { UserId } from './ids';

function subject(id: string, email = `${id}@example.com`): IdentitySubject {
	return { id: UserId.parse(id), email };
}

describe('identityMatch', () => {
	describe('foldCase / normalizeEmail', () => {
		it('trims surrounding whitespace and lowercases', () => {
			expect(foldCase('  MiXeD@Example.COM  ')).toBe('mixed@example.com');
		});

		it('leaves inner characters and separators intact', () => {
			expect(foldCase('A B\tC')).toBe('a b\tc');
		});

		it('returns empty for blank input', () => {
			expect(foldCase('   ')).toBe('');
			expect(foldCase('')).toBe('');
		});

		it('normalizeEmail is the same fold, named for intent', () => {
			expect(normalizeEmail(' User@Host ')).toBe('user@host');
		});
	});

	describe('emailsEqual', () => {
		it('is case- and whitespace-insensitive', () => {
			expect(emailsEqual('Ada@Example.com', ' ada@example.COM ')).toBe(true);
		});

		it('distinguishes different addresses', () => {
			expect(emailsEqual('ada@example.com', 'bob@example.com')).toBe(false);
		});

		it('treats two blanks as equal (both fold to empty)', () => {
			expect(emailsEqual('', '   ')).toBe(true);
		});
	});

	describe('isEmailRef', () => {
		it('is true when an `@` is present, anywhere', () => {
			expect(isEmailRef('a@b.com')).toBe(true);
			expect(isEmailRef('@leading')).toBe(true);
			expect(isEmailRef('trailing@')).toBe(true);
			expect(isEmailRef('two@@ats')).toBe(true);
		});

		it('is false for an `@`-free id', () => {
			expect(isEmailRef('user_01HXY')).toBe(false);
			expect(isEmailRef('')).toBe(false);
		});
	});

	describe('refMatchesSubject', () => {
		const s = subject('user_god', 'god@corp.example');

		it('an email ref matches the email, case-insensitively — not the id', () => {
			expect(refMatchesSubject('GOD@Corp.Example', s)).toBe(true);
			expect(refMatchesSubject('god@corp.example', { ...s, email: 'other@corp.example' })).toBe(
				false,
			);
		});

		it('an id ref matches the id exactly — never case-variant, never the email', () => {
			expect(refMatchesSubject('user_god', s)).toBe(true);
			expect(refMatchesSubject('USER_GOD', s)).toBe(false);
			expect(refMatchesSubject('user_other', s)).toBe(false);
		});

		it('never crosses the id/email namespace (the collision guard)', () => {
			// An email ref must not elevate a caller whose *id* equals the string.
			const idImpostor = subject('admin@example.com', 'attacker@evil.example');
			expect(refMatchesSubject('admin@example.com', idImpostor)).toBe(false);
			// An id ref must not elevate a caller whose *email* echoes the string.
			const emailImpostor = subject('stranger', 'user_admin@example.com');
			expect(refMatchesSubject('user_admin', emailImpostor)).toBe(false);
		});
	});

	describe('anyRefMatchesSubject', () => {
		const s = subject('user_god');

		it('is false for an undefined or empty list', () => {
			expect(anyRefMatchesSubject(undefined, s)).toBe(false);
			expect(anyRefMatchesSubject([], s)).toBe(false);
		});

		it('is true when any entry matches, false when none do', () => {
			expect(anyRefMatchesSubject(['nobody@x.io', 'user_god'], s)).toBe(true);
			expect(anyRefMatchesSubject(['nobody@x.io', 'user_other'], s)).toBe(false);
		});
	});

	describe('memberRefMatchesSubject', () => {
		const s = subject('user_ada', 'ada@example.com');

		it('matches an id row by exact id', () => {
			expect(memberRefMatchesSubject({ user_id: s.id }, s)).toBe(true);
			expect(memberRefMatchesSubject({ user_id: UserId.parse('user_bob') }, s)).toBe(false);
		});

		it('matches an invite row by case-insensitive email', () => {
			expect(memberRefMatchesSubject({ email: 'ADA@Example.com' }, s)).toBe(true);
			expect(memberRefMatchesSubject({ email: 'bob@example.com' }, s)).toBe(false);
		});

		it('an id row never matches via the email, and vice versa', () => {
			// Row keyed by id, but the subject only shares the email → no match.
			expect(
				memberRefMatchesSubject(
					{ user_id: UserId.parse('user_bob') },
					{
						id: UserId.parse('user_bob_other'),
						email: 'ada@example.com',
					},
				),
			).toBe(false);
			// Row keyed by email, but the subject only shares the id → no match.
			expect(
				memberRefMatchesSubject({ email: 'ada@example.com' }, subject('user_ada', 'x@y.io')),
			).toBe(false);
		});
	});

	describe('memberRefMatchesSelector', () => {
		it('matches an id row by exact selector', () => {
			expect(memberRefMatchesSelector({ user_id: UserId.parse('user_ada') }, 'user_ada')).toBe(
				true,
			);
			expect(memberRefMatchesSelector({ user_id: UserId.parse('user_ada') }, 'user_bob')).toBe(
				false,
			);
		});

		it('matches an invite row by case-insensitive email selector', () => {
			expect(memberRefMatchesSelector({ email: 'ada@example.com' }, 'ADA@Example.com')).toBe(true);
			expect(memberRefMatchesSelector({ email: 'ada@example.com' }, 'bob@example.com')).toBe(false);
		});
	});
});
