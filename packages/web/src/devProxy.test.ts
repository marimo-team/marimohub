import { describe, expect, it } from 'vitest';
import { devApiTarget } from '../devProxy';

describe('devApiTarget', () => {
	it.each([
		[{}, 'http://127.0.0.1:3000'],
		[{ DEV_HOST: '127.42.0.1', PORT: '4100' }, 'http://127.42.0.1:4100'],
		[{ DEV_HOST: '::1' }, 'http://[::1]:3000'],
		[{ DEV_HOST: '0:0:0:0:0:0:0:1' }, 'http://[0:0:0:0:0:0:0:1]:3000'],
		[{ DEV_HOST: '2001:db8::5' }, 'http://[2001:db8::5]:3000'],
		[{ DEV_HOST: '0.0.0.0' }, 'http://127.0.0.1:3000'],
		[{ DEV_HOST: '::' }, 'http://[::1]:3000'],
		[{ DEV_HOST: '0:0:0:0:0:0:0:0' }, 'http://[::1]:3000'],
		[{ DEV_HOST: '0::0' }, 'http://[::1]:3000'],
		[{ DEV_HOST: '::0' }, 'http://[::1]:3000'],
		[{ DEV_HOST: '0000::0000' }, 'http://[::1]:3000'],
		[{ DEV_HOST: '::0.0.0.0' }, 'http://[::1]:3000'],
	])('uses the API bind host for %j', (env, expected) => {
		expect(devApiTarget(env)).toBe(expected);
	});
});
