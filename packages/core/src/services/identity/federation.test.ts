import { describe, expect, it, vi } from 'vitest';
import type { ProjectId, SessionId } from '../../ids';
import type { FederationTarget } from '../../ports/credentialBroker';
import { exchangeFederatedStorageEnv, projectSubject } from './federation';
import type { WorkloadIdentityIssuer } from './WorkloadIdentityIssuer';

describe('projectSubject', () => {
	it('uses the project id verbatim (its `proj-` prefix is the namespace)', () => {
		expect(projectSubject('proj-abc' as ProjectId)).toBe('proj-abc');
	});
});

describe('exchangeFederatedStorageEnv', () => {
	const pid = 'proj-abc' as ProjectId;
	const sid = 's_def' as SessionId;

	it('mints with the project subject + target audience, exchanges, and maps to S3 env', async () => {
		const mint = vi.fn(async () => 'jwt.value');
		const issuer = { mint } as unknown as WorkloadIdentityIssuer;
		const exchange = vi.fn(async () => ({
			accessKeyId: 'AK',
			secretAccessKey: 'sk',
			sessionToken: 'tok',
		}));
		const target: FederationTarget = {
			broker: { exchange },
			audience: 'aud-123',
			storage: { endpoint: 'https://store.example', region: 'r1' },
		};

		const env = await exchangeFederatedStorageEnv(
			issuer,
			'https://hub.example.com',
			target,
			pid,
			sid,
		);

		expect(mint).toHaveBeenCalledWith({
			iss: 'https://hub.example.com',
			sub: 'proj-abc',
			aud: 'aud-123',
			extraClaims: { project_id: pid, session_id: sid },
		});
		expect(exchange).toHaveBeenCalledWith('jwt.value');
		expect(env).toEqual({
			AWS_ACCESS_KEY_ID: 'AK',
			AWS_SECRET_ACCESS_KEY: 'sk',
			AWS_SESSION_TOKEN: 'tok',
			AWS_ENDPOINT_URL_S3: 'https://store.example',
			AWS_REGION: 'r1',
		});
	});

	it('propagates a broker exchange failure to the caller', async () => {
		const issuer = { mint: async () => 'jwt' } as unknown as WorkloadIdentityIssuer;
		const target: FederationTarget = {
			broker: {
				exchange: async () => {
					throw new Error('denied');
				},
			},
			audience: 'aud',
			storage: { endpoint: 'https://store.example' },
		};
		await expect(
			exchangeFederatedStorageEnv(issuer, 'https://hub', target, pid, sid),
		).rejects.toThrow('denied');
	});
});
