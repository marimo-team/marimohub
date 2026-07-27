import { Button, CopyField, DialogModal, WriteOnceWarning } from '@/components/ui';
import { DOCS_SYNCING_URL } from '@/lib/links';

export interface SyncKeysDialogProps {
	isOpen: boolean;
	onClose: () => void;
	title: string;
	syncUrl: string;
	/** The write-once token, present only right after creation or rotation. */
	token?: string;
}

/**
 * Show a synced notebook's sync credentials. The URL is always available
 * (derived from the notebook), but the token is write-once: it appears here only
 * straight after creation or rotation. Otherwise we tell the user to rotate to
 * mint a new one — the server keeps only a hash.
 */
export function SyncKeysDialog({ isOpen, onClose, title, syncUrl, token }: SyncKeysDialogProps) {
	return (
		<DialogModal isOpen={isOpen} onClose={onClose} title={`Sync keys — ${title}`} width="md">
			<div className="flex flex-col gap-4">
				<p className="text-sm leading-relaxed text-muted-foreground">
					An external pusher (e.g. a CI workflow) POSTs your repo subtree to this URL with the token
					as a bearer credential.{' '}
					<a
						href={DOCS_SYNCING_URL}
						target="_blank"
						rel="noreferrer"
						className="text-primary underline-offset-2 hover:underline"
					>
						Learn more
					</a>
					.
				</p>

				<CopyField label="Sync URL" value={syncUrl} />

				{token ? (
					<>
						<CopyField label="Sync token" value={token} />
						<WriteOnceWarning />
					</>
				) : (
					<p className="rounded-md border border-input bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
						The token is shown only when the notebook is created or its token is rotated. Rotate the
						token to mint a new one.
					</p>
				)}

				<div className="flex justify-end pt-2">
					<Button variant="primary" onPress={onClose}>
						Done
					</Button>
				</div>
			</div>
		</DialogModal>
	);
}
