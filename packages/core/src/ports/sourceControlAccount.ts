export interface SourceControlUserTokens {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	refreshExpiresAt: number;
}

export interface SourceControlAccountIdentity {
	id: string;
	login: string;
}

export interface SourceControlAccountProvider {
	readonly provider: string;
	readonly origin: string;
	readonly clientId: string;
	authorizationUrl(input: { state: string; challenge: string; redirectUri: string }): string;
	exchange(input: {
		code: string;
		verifier: string;
		redirectUri: string;
	}): Promise<SourceControlUserTokens>;
	refresh(refreshToken: string): Promise<SourceControlUserTokens>;
	identity(accessToken: string): Promise<SourceControlAccountIdentity>;
	revoke(accessToken: string): Promise<void>;
}

export interface SourceControlAccountReference {
	connectionId: string;
	generation: string;
	accountId: string;
}
