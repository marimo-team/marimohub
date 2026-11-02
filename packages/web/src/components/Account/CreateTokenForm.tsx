import { useState } from 'react';
import { toast } from 'sonner';
import { useCreateScopedToken } from '@/api/hooks';
import { Button, TextField } from '@/components/ui';
import { Plus } from 'lucide-react';
import type { ApiTokenCreated } from '@/types';
import { TokenGrantEditor } from './TokenGrantEditor';
import { tokenGrantFromDraft } from './tokenGrantDraft';
import type { TokenGrantDraft } from './tokenGrantDraft';

export function CreateTokenForm({
	kind,
	onCreated,
}: {
	kind: 'api' | 'mcp';
	onCreated: (token: ApiTokenCreated) => void;
}) {
	const createToken = useCreateScopedToken(kind);
	const defaultExpiry = kind === 'mcp' ? '30' : '';
	const [name, setName] = useState('');
	const [expiresInDays, setExpiresInDays] = useState(defaultExpiry);
	const [draft, setDraft] = useState<TokenGrantDraft>({ actions: null, projects: null });
	const grant = tokenGrantFromDraft(draft);

	const create = async () => {
		if (!name.trim()) {
			toast.error('Name the token so you can recognize it later.');
			return;
		}
		const days = expiresInDays.trim();
		if (days && (!/^\d+$/.test(days) || Number(days) < 1 || Number(days) > 3650)) {
			toast.error('Expiry must be a whole number from 1 to 3650 days.');
			return;
		}
		if (!grant) return;
		try {
			const created = await createToken.mutateAsync({
				name: name.trim(),
				...(days ? { expires_in_days: Number(days) } : {}),
				grant,
			});
			onCreated(created);
			setName('');
			setExpiresInDays(defaultExpiry);
			setDraft({ actions: null, projects: null });
		} catch {
			return;
		}
	};

	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				void create();
			}}
			className="flex flex-col gap-3"
		>
			<div className="flex gap-2">
				<div className="flex-1">
					<TextField
						label="Name"
						placeholder={kind === 'mcp' ? 'my-mcp-client' : 'ci-deploy'}
						value={name}
						onChange={setName}
					/>
				</div>
				<div className="w-36 shrink-0">
					<TextField
						label="Expires in days"
						placeholder="never"
						value={expiresInDays}
						onChange={setExpiresInDays}
					/>
				</div>
			</div>
			<TokenGrantEditor value={draft} onChange={setDraft} />
			<Button
				type="submit"
				variant="primary"
				className="self-end"
				isDisabled={createToken.isPending || !grant}
			>
				{kind === 'api' && <Plus className="size-4" />}
				{createToken.isPending ? 'Creating…' : kind === 'mcp' ? 'Create MCP token' : 'Create token'}
			</Button>
		</form>
	);
}
