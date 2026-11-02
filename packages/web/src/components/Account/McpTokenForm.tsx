import { useState } from 'react';
import { CopyField, WriteOnceWarning } from '@/components/ui';
import { CreateTokenForm } from './CreateTokenForm';

export function McpTokenForm() {
	const [token, setToken] = useState<string | null>(null);
	return token ? (
		<div className="flex flex-col gap-3">
			<p>Use Streamable HTTP with the server URL above and this request header:</p>
			<CopyField label="Header name" value="Authorization" />
			<CopyField label="Header value" value={`Bearer ${token}`} />
			<WriteOnceWarning />
			<p className="text-muted-foreground">Manage or revoke this token in API tokens.</p>
		</div>
	) : (
		<>
			<p>Create a token for a client that accepts an Authorization header without OAuth.</p>
			<CreateTokenForm kind="mcp" onCreated={(created) => setToken(created.token)} />
		</>
	);
}
