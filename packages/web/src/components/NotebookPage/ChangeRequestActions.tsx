import { ChevronDown, GitPullRequest, RefreshCw } from 'lucide-react';
import { useRef } from 'react';
import { toast } from 'sonner';
import {
	notebookChangeRequestScope,
	useNotebookChangeRequestPublisher,
} from '@/api/changeRequests';
import type { PublishChangeRequestAction } from '@/api/changeRequests';
import { Button, DropdownMenu } from '@/components/ui';

interface ChangeRequestTerms {
	kind: string;
	open: string;
	view: string;
	update: string;
	create: string;
}

function termsForProvider(provider: string): ChangeRequestTerms {
	if (provider === 'github') {
		return {
			kind: 'pull request',
			open: 'Open PR',
			view: 'View PR',
			update: 'Update PR',
			create: 'Create new PR',
		};
	}
	if (provider === 'gitlab') {
		return {
			kind: 'merge request',
			open: 'Open MR',
			view: 'View MR',
			update: 'Update MR',
			create: 'Create new MR',
		};
	}
	return {
		kind: 'change request',
		open: 'Open change request',
		view: 'View change request',
		update: 'Update change request',
		create: 'Create new change request',
	};
}

function openChangeRequestUrl(url: string): void {
	const opened = window.open(url, '_blank');
	if (opened) opened.opener = null;
	else window.location.assign(url);
}

function resolvePendingWindow(opened: Window | null, url: string): void {
	if (opened) opened.location.href = url;
	else window.location.assign(url);
}

export interface ChangeRequestActionsProps {
	projectId: string;
	notebookId: string;
	sessionId?: string;
	notebookTitle: string;
	provider?: string | null;
	canPublish: boolean;
}

export function ChangeRequestActions({
	projectId,
	notebookId,
	sessionId,
	notebookTitle,
	provider,
	canPublish,
}: ChangeRequestActionsProps) {
	const scope = notebookChangeRequestScope(projectId, notebookId);
	const currentScope = useRef(scope);
	currentScope.current = scope;
	const publisher = useNotebookChangeRequestPublisher(projectId, notebookId);
	const activeChangeRequest = publisher.activeChangeRequest;
	const publishingAvailable = canPublish && !!sessionId && !!provider;
	if (!activeChangeRequest && !publishingAvailable) return null;

	const terms = termsForProvider(activeChangeRequest?.change_request.provider ?? provider ?? '');
	const publish = (action: PublishChangeRequestAction) => {
		if (!sessionId) return;
		const requestScope = scope;
		const pendingWindow = window.open('about:blank', '_blank');
		if (pendingWindow) pendingWindow.opener = null;
		publisher.mutate(
			{ sessionId, title: `Update ${notebookTitle}`, action },
			{
				onSuccess: (data) => {
					if (currentScope.current !== requestScope) {
						pendingWindow?.close();
						return;
					}
					resolvePendingWindow(pendingWindow, data.change_request.url);
					toast.success(
						`${action === 'update' ? 'Updated' : 'Opened'} ${terms.kind} #${data.change_request.number}`,
					);
				},
				onError: () => pendingWindow?.close(),
			},
		);
	};

	if (!activeChangeRequest) {
		return (
			<Button
				variant="unstyled"
				className="flex h-[26px] items-center gap-1 rounded-md border border-input px-2 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary max-md:min-h-11"
				isDisabled={publisher.isPending}
				onPress={() => publish('open')}
			>
				<GitPullRequest className="size-3" />
				{publisher.isPending ? 'Opening…' : terms.open}
			</Button>
		);
	}
	const viewButton = (
		<Button
			variant="unstyled"
			className={`flex h-[26px] items-center gap-1 border border-input px-2 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary max-md:min-h-11 ${publishingAvailable ? 'rounded-l-md' : 'rounded-md'}`}
			onPress={() => openChangeRequestUrl(activeChangeRequest.change_request.url)}
		>
			<GitPullRequest className="size-3" />
			{terms.view}
		</Button>
	);
	if (!publishingAvailable) return viewButton;

	return (
		<div className="flex items-center">
			{viewButton}
			<DropdownMenu
				label={`${terms.kind} options`}
				icon={<ChevronDown className="size-3" />}
				triggerClassName="h-[26px] w-6 rounded-r-md border border-l-0 border-input hover:border-primary max-md:h-11"
				isDisabled={publisher.isPending}
				options={[
					{
						id: 'update',
						label: terms.update,
						icon: <RefreshCw className="size-3.5" />,
					},
					{
						id: 'create-new',
						label: terms.create,
						icon: <GitPullRequest className="size-3.5" />,
					},
				]}
				onAction={(action) => publish(action as 'update' | 'create-new')}
			/>
		</div>
	);
}
