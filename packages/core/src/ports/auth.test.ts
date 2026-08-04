import { describe, expectTypeOf, it } from 'vitest';
import type { AuthEntitlement, AuthUser } from './auth';

describe('AuthUser', () => {
	it('exposes resolved entitlements as readonly authorization data', () => {
		expectTypeOf<AuthUser['entitlements']>().toEqualTypeOf<
			readonly AuthEntitlement[] | undefined
		>();
	});
});
