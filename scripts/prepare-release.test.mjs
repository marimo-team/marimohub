import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextVersion } from './prepare-release.mjs';

await test('bumps stable versions', () => {
	assert.equal(nextVersion('1.2.3', 'patch'), '1.2.4');
	assert.equal(nextVersion('1.2.3', 'minor'), '1.3.0');
	assert.equal(nextVersion('1.2.3', 'major'), '2.0.0');
	assert.equal(nextVersion('1.2.3', '1.10.0'), '1.10.0');
});
await test('rejects invalid, equal, and regressing versions', () => {
	for (const requested of [
		'1.2.3',
		'1.2.2',
		'0.9.9',
		'01.3.0',
		'2.0.0-rc.1',
		'1.2.4\n',
		'1.2.4\r\n',
		'1.2.4\r',
		'1.2.4\u2028',
		'1.2.4\u2029',
		undefined,
	]) {
		assert.throws(() => nextVersion('1.2.3', requested));
	}
});
