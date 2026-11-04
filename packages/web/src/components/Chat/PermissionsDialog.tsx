import { useChatPermissions, useRevokeChatPermission } from '@/api/conversations';
import { Button, DialogModal } from '@/components/ui';

export function PermissionsDialog({ pid, onClose }: { pid: string; onClose: () => void }) {
	const permissions = useChatPermissions(pid);
	const revoke = useRevokeChatPermission(pid);
	return (
		<DialogModal isOpen onClose={onClose} title="Remembered permissions" width="lg">
			<p className="mb-4 text-sm text-muted-foreground">
				Actions you allowed with “Always allow” run without asking again in this project.
				Irreversible actions always ask.
			</p>
			{permissions.isPending && <p>Loading permissions…</p>}
			{permissions.isError && <p role="alert">Permissions could not be loaded.</p>}
			{permissions.data?.grants.length === 0 && <p>No remembered permissions in this project.</p>}
			<ul className="divide-y">
				{permissions.data?.grants.map((grant) => (
					<li key={grant.id} className="flex items-center justify-between gap-4 py-3">
						<div className="min-w-0 break-words">
							<p className="font-medium">{grant.action}</p>
							<p className="text-sm text-muted-foreground">{grant.scope_label}</p>
							<time className="text-xs text-muted-foreground" dateTime={grant.created_at}>
								{new Date(grant.created_at).toLocaleDateString()}
							</time>
						</div>
						<Button
							isDisabled={revoke.isPending}
							onPress={() => revoke.mutate(grant.id)}
							aria-label={`Remove ${grant.action} for ${grant.scope_label}`}
						>
							Remove
						</Button>
					</li>
				))}
			</ul>
		</DialogModal>
	);
}
