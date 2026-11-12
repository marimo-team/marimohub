import { Link } from 'react-router-dom';
import { useCapabilitiesQuery } from '@/api/hooks';
import { useGitHubAccount } from '@/api/githubAccount';

export function PersonalPublishingNotice({ provider }: { provider?: string | null }) {
	const { data: capabilities } = useCapabilitiesQuery();
	const personal =
		provider === 'github' && capabilities?.source_control?.github_publish_actor === 'user';
	const { data } = useGitHubAccount(personal);
	if (!personal) return null;
	return (
		<Link
			to="/account/github"
			className="text-xs text-muted-foreground underline"
			title="Personal publications require verified commits. Local commits and merge commits have separate signing behavior."
		>
			{data?.account?.connected
				? `Publish as @${data.account.login} · signature required`
				: data?.account
					? 'Reconnect GitHub to publish'
					: 'Connect GitHub to publish'}
		</Link>
	);
}
