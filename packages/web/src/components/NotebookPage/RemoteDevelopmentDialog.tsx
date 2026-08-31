import { MonitorUp } from 'lucide-react';
import { Button, CopyField, DialogModal } from '@/components/ui';
import { useDisclosure } from '@/hooks/useDisclosure';
import type { Session } from '@/types';

type Persistence = 'workspace' | 'source' | 'none';

export function persistenceWarning(persistence: Persistence): string {
	if (persistence === 'workspace') {
		return 'Files under /workspace are captured when the session stops under the deployment workspace policy.';
	}
	if (persistence === 'source') {
		return 'Only the supported source files persist. Other files under /workspace are discarded when the session stops.';
	}
	return 'Edits are not persisted automatically. Use the existing Git or change-request workflow before the session stops.';
}

export function RemoteDevelopmentDialog({
	projectId,
	notebookId,
	session,
	persistence,
}: {
	projectId: string;
	notebookId: string;
	session: Session | null | undefined;
	persistence: Persistence;
}) {
	const dialog = useDisclosure();
	if (!session?.can.develop || !session.remote_development.ssh.available) return null;
	const command = `mohub sessions code --pid ${projectId} --nid ${notebookId} --sid ${session.session_id}`;

	return (
		<>
			<Button
				variant="unstyled"
				className="flex h-[26px] items-center gap-1 rounded-md border border-input px-2 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary max-md:min-h-11"
				onPress={dialog.open}
			>
				<MonitorUp className="size-3" />
				Connect desktop VS Code
			</Button>
			<DialogModal
				isOpen={dialog.isOpen}
				onClose={dialog.close}
				title="Connect desktop VS Code"
				width="lg"
			>
				<div className="flex flex-col gap-4">
					<p className="text-sm text-muted-foreground">
						Run this command on a computer with the mohub CLI, OpenSSH, VS Code, and the Remote-SSH
						extension installed.
					</p>
					<CopyField label="CLI command" value={command} />
					<div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-muted-foreground">
						{persistenceWarning(persistence)}
					</div>
				</div>
			</DialogModal>
		</>
	);
}
