import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { Button, ConfirmDialog, FormDialog, TextField } from '@/components/ui';
import { useAdminInvitationsQuery, useInviteUser, useRevokeInvitation } from '@/api/hooks';

export function AdminInvitations() {
	const { data } = useAdminInvitationsQuery();
	const invite = useInviteUser();
	const revoke = useRevokeInvitation();
	const [isOpen, setIsOpen] = useState(false);
	const [email, setEmail] = useState('');
	const [removing, setRemoving] = useState<string | null>(null);
	if (!data.enabled && data.items.length === 0) return null;

	return (
		<section className="mb-6 rounded-xl border bg-card p-4" aria-label="External invitations">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h2 className="font-semibold">External invitations</h2>
					<p className="mt-1 text-sm text-muted-foreground">
						{data.enabled
							? 'Allow specific people outside your allowed domains to sign in.'
							: 'External invitations are disabled. These invitations do not grant access.'}
					</p>
				</div>
				{data.enabled && (
					<Button
						onPress={() => {
							setEmail('');
							setIsOpen(true);
						}}
					>
						<UserPlus className="size-4" />
						Invite user
					</Button>
				)}
			</div>
			{data.items.length > 0 && (
				<ul className="mt-4 divide-y border-t">
					{data.items.map((invitation) => (
						<li key={invitation.email} className="flex items-center justify-between gap-3 py-2">
							<span className="truncate text-sm">{invitation.email}</span>
							<Button
								variant="ghost"
								size="sm"
								aria-label={`Remove invitation for ${invitation.email}`}
								onPress={() => setRemoving(invitation.email)}
							>
								Remove
							</Button>
						</li>
					))}
				</ul>
			)}
			<FormDialog
				isOpen={isOpen}
				onClose={() => {
					if (!invite.isPending) setIsOpen(false);
				}}
				title="Invite user"
				submitLabel="Add invitation"
				pendingLabel="Adding…"
				isPending={invite.isPending}
				submitDisabled={!email.trim()}
				onSubmit={() => {
					if (invite.isPending || !email.trim()) return;
					invite.mutate(email.trim(), {
						onSuccess: () => {
							setIsOpen(false);
							toast.success('Invitation added. Share your sign-in link with them.');
						},
					});
				}}
			>
				<TextField
					label="Email address"
					type="email"
					value={email}
					onChange={setEmail}
					isRequired
					autoFocus
				/>
				<p className="text-sm text-muted-foreground">
					They must sign in with this email through your identity provider. No email is sent.
					Project access follows your existing permissions.
				</p>
			</FormDialog>
			<ConfirmDialog
				isOpen={removing !== null}
				onClose={() => setRemoving(null)}
				title="Remove invitation"
				description={`Remove the domain exception for ${removing ?? 'this email'}? Access through an allowed domain is unaffected. Running sandbox sessions are not terminated.`}
				confirmLabel="Remove invitation"
				variant="danger"
				isPending={revoke.isPending}
				onConfirm={() => {
					if (removing)
						revoke.mutate(removing, {
							onSuccess: () => {
								setRemoving(null);
								toast.success('Invitation removed');
							},
						});
				}}
			/>
		</section>
	);
}
