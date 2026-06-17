import { describe, it, expect } from 'vitest';
import { WorkloadIdentityIssuer } from '@marimo-hub/core';
import { AwsStsWifBroker } from '@marimo-hub/credentials-aws';
import { CoreWeaveWifBroker } from '@marimo-hub/credentials-coreweave';
import { makeWif } from './wif';

// A placeholder PKCS8 PEM. `WorkloadIdentityIssuer` imports the key lazily (only
// when it signs), so construction never parses this — it just has to look like a
// PEM to clear `makeWif`'s format check.
const FAKE_PEM = '-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----';

const fullEnv = {
	MARIMOHUB_WIF_SIGNING_KEY: FAKE_PEM,
	MARIMOHUB_WIF_KID: 'kid-1',
	MARIMOHUB_WIF_ISSUER_URL: 'https://hub.example.com/',
	MARIMOHUB_WIF_AUDIENCE: 'sts.coreweave',
	MARIMOHUB_WIF_BROKER: 'coreweave',
	MARIMOHUB_WIF_COREWEAVE_EXCHANGE_URL: 'https://exchange.coreweave',
};

describe('makeWif enablement', () => {
	it('returns an empty config when no WIF vars are set (disabled)', () => {
		expect(makeWif({})).toEqual({});
	});

	it('throws listing the missing vars when partially configured', () => {
		expect(() => makeWif({ MARIMOHUB_WIF_BROKER: 'coreweave' })).toThrow(/partially configured/);
		expect(() => makeWif({ MARIMOHUB_WIF_BROKER: 'coreweave' })).toThrow(
			/MARIMOHUB_WIF_SIGNING_KEY/,
		);
	});
});

describe('makeWif signing key', () => {
	it('rejects a signing key that is not a PEM', () => {
		expect(() => makeWif({ ...fullEnv, MARIMOHUB_WIF_SIGNING_KEY: 'not-a-key' })).toThrow(
			/PKCS8 PEM/,
		);
	});

	it('accepts a single-line base64-encoded PEM', () => {
		const { wif } = makeWif({ ...fullEnv, MARIMOHUB_WIF_SIGNING_KEY: btoa(FAKE_PEM) });
		expect(wif?.issuer).toBeInstanceOf(WorkloadIdentityIssuer);
	});
});

describe('makeWif wiring', () => {
	it('builds the issuer, canonical issuer URL, and coreweave federation target', () => {
		const { wif } = makeWif({
			...fullEnv,
			MARIMOHUB_WIF_STORAGE_ENDPOINT: 'https://cwobject.com',
			MARIMOHUB_WIF_STORAGE_REGION: 'us-east-1',
		});
		expect(wif?.issuer).toBeInstanceOf(WorkloadIdentityIssuer);
		// Trailing slash stripped so `iss`/`jwks_uri` are canonical.
		expect(wif?.issuerUrl).toBe('https://hub.example.com');
		expect(wif?.target.audience).toBe('sts.coreweave');
		expect(wif?.target.broker).toBeInstanceOf(CoreWeaveWifBroker);
		expect(wif?.target.storage).toEqual({
			endpoint: 'https://cwobject.com',
			region: 'us-east-1',
		});
	});

	it('throws on an unknown broker, listing the supported ones', () => {
		expect(() => makeWif({ ...fullEnv, MARIMOHUB_WIF_BROKER: 'azure' })).toThrow(
			/Unknown MARIMOHUB_WIF_BROKER.*coreweave, aws/,
		);
	});

	it('requires the coreweave exchange url', () => {
		const { MARIMOHUB_WIF_COREWEAVE_EXCHANGE_URL: _omit, ...env } = fullEnv;
		expect(() => makeWif(env)).toThrow(/MARIMOHUB_WIF_COREWEAVE_EXCHANGE_URL/);
	});
});

describe('makeWif aws broker', () => {
	const awsEnv = {
		MARIMOHUB_WIF_SIGNING_KEY: FAKE_PEM,
		MARIMOHUB_WIF_KID: 'kid-1',
		MARIMOHUB_WIF_ISSUER_URL: 'https://hub.example.com',
		MARIMOHUB_WIF_AUDIENCE: 'sts.amazonaws.com',
		MARIMOHUB_WIF_BROKER: 'aws',
		MARIMOHUB_WIF_AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/marimohub-wif',
	};

	it('builds the aws federation target with no S3 endpoint override', () => {
		const { wif } = makeWif({ ...awsEnv, MARIMOHUB_WIF_STORAGE_REGION: 'us-east-1' });
		expect(wif?.target.broker).toBeInstanceOf(AwsStsWifBroker);
		// AWS S3 uses the SDK default endpoint — no AWS_ENDPOINT_URL_S3 injection.
		expect(wif?.target.storage).toEqual({ endpoint: undefined, region: 'us-east-1' });
	});

	it('accepts a regional STS endpoint', () => {
		const { wif } = makeWif({
			...awsEnv,
			MARIMOHUB_WIF_AWS_STS_URL: 'https://sts.us-east-1.amazonaws.com',
		});
		expect(wif?.target.broker).toBeInstanceOf(AwsStsWifBroker);
	});

	it('requires the role ARN', () => {
		const { MARIMOHUB_WIF_AWS_ROLE_ARN: _omit, ...env } = awsEnv;
		expect(() => makeWif(env)).toThrow(/MARIMOHUB_WIF_AWS_ROLE_ARN/);
	});
});
