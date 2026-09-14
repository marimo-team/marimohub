import { describe, expect, it } from 'vitest';
import { bearerToken, parseBearerAuthorization } from './bearerToken';

function request(authorization?: string): Request {
	return new Request('https://hub.example', {
		headers: authorization === undefined ? {} : { authorization },
	});
}

describe('bearer authorization parsing', () => {
	it.each(['Bearer token', 'bEaReR token', 'Bearer  token', 'Bearer\ttoken'])(
		'accepts %j consistently',
		(header) => {
			expect(parseBearerAuthorization(request(header))).toEqual({ kind: 'bearer', token: 'token' });
			expect(bearerToken(request(header))).toBe('token');
		},
	);

	it.each([undefined, '', 'Basic abc==', 'Digest token', 'Bearertoken'])(
		'does not interpret %j as a bearer scheme',
		(header) => {
			expect(parseBearerAuthorization(request(header))).toEqual({ kind: 'absent' });
			expect(bearerToken(request(header))).toBeNull();
		},
	);

	it.each([
		'Bearer',
		'Bearer ',
		'Bearer one two',
		'Bearer one\ttwo',
		'Bearer "token"',
		'Bearer =',
		'Bearer a=b',
		'Bearer token,',
		',Bearer token',
		'Bearer one, Bearer two',
		'Basic abc, bEaReR\ttoken',
		'Bearer token, Basic abc',
		`Bearer ${'a'.repeat(32769)}`,
		'Bearer\u00a0token',
	])('rejects malformed or ambiguous header %#', (header) => {
		expect(parseBearerAuthorization(request(header))).toEqual({ kind: 'invalid' });
		expect(bearerToken(request(header))).toBeNull();
	});

	it('accepts token syntax and the maximum length without decoding it', () => {
		for (const token of ['abc._~+/-==', 'a'.repeat(32768)]) {
			expect(bearerToken(request(`Bearer ${token}`))).toBe(token);
		}
	});

	it('rejects duplicate header fields as presented by Fetch', () => {
		const headers = new Headers();
		headers.append('Authorization', 'Bearer first');
		headers.append('Authorization', 'Bearer second');
		expect(parseBearerAuthorization(new Request('https://hub.example', { headers }))).toEqual({
			kind: 'invalid',
		});
	});
});
