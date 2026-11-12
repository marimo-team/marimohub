import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui';
import { useGitHubAccount, useConnectGitHub, useDisconnectGitHub } from '@/api/githubAccount';
import { DOCS_BASE } from '@/lib/links';

export function GitHubAccountPage() {
	const { data, isPending, error } = useGitHubAccount();
	const connect = useConnectGitHub();
	const disconnect = useDisconnectGitHub();
	const [params] = useSearchParams();
	return (
		<section className="mx-auto flex w-full max-w-xl flex-col gap-4 p-6">
			<h1 className="text-xl font-semibold">GitHub account</h1>
			{isPending ? <p>Loading connection…</p> : null}
			{error ? <p role="alert">{error.message}</p> : null}
			{params.get('connection') === 'failed' ? (
				<p role="alert">
					GitHub connection could not be completed. Start a new connection in this browser.
				</p>
			) : null}
			{data ? (
				<>
					<p>
						{data.account
							? `Connected account: @${data.account.login}`
							: 'No personal GitHub account connected.'}
					</p>
					<p>
						{data.enabled
							? 'Publishing uses your GitHub account and requires verified commits. Hub permissions and repository policies still apply.'
							: 'This deployment publishes through the shared GitHub App.'}
					</p>
					{data.account && !data.account.connected ? (
						<p role="alert">
							This connection needs to be replaced. Disconnect it, then connect again.
						</p>
					) : null}
					<p className="text-sm text-muted-foreground">
						GitHub credentials stay on the server. Verification establishes commit provenance, not
						human review. Local Git commits have separate attribution and are not signed by this
						connection.
					</p>
					<p className="text-sm text-muted-foreground">
						Same-origin proxy notebooks can invoke hub actions as you. Only use trusted notebooks in
						proxy mode.{' '}
						<a className="underline" href={`${DOCS_BASE}/security`}>
							Security guidance
						</a>
					</p>
					<div className="flex gap-3">
						{data.enabled && !data.account ? (
							<Button onPress={() => connect.mutate()} isDisabled={connect.isPending}>
								Connect GitHub
							</Button>
						) : null}
						{data.account ? (
							<Button
								onPress={() =>
									disconnect.mutate(undefined, {
										onSuccess: (result) => {
											if (!result.remote_revocation_confirmed)
												toast.warning(
													'Disconnected locally. Revoke the App authorization in GitHub to confirm remote revocation.',
												);
											else toast.success('GitHub account disconnected');
										},
									})
								}
								isDisabled={disconnect.isPending}
							>
								Disconnect GitHub
							</Button>
						) : null}
					</div>
					{connect.error || disconnect.error ? (
						<p role="alert">{(connect.error ?? disconnect.error)?.message}</p>
					) : null}
					<p className="text-sm text-muted-foreground">
						Disconnect stops new personal writes. It cannot cancel a request already sent to GitHub
						or erase published commits.
					</p>
				</>
			) : null}
		</section>
	);
}
