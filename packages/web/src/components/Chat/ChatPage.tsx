import { PanelLeft, Notebook, Plus, ShieldCheck } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { Button, ConfirmDialog } from '@/components/ui';
import { PageTitle } from '@/components/ui/PageTitle';
import { ChatMessages } from './ChatMessages';
import { ChatEmptyState } from './ChatEmptyState';
import { ContinuationControls } from './ContinuationControls';
import { ChatComposer } from './ChatComposer';
import { ConversationSidebar } from './ConversationSidebar';
import { ChatProgress } from './ToolActivity';
import { PermissionsDialog } from './PermissionsDialog';
import { NotebookPane } from './NotebookPane';
import { ContextInspector, MissingInspector } from './ContextInspector';
import { PaneDivider } from './PaneDivider';
import { useProjectChatController } from './useProjectChatController';

function ProjectChat({ pid }: { pid: string }) {
	const c = useProjectChatController(pid);
	const composerElement = (
		<ChatComposer
			home={c.home}
			error={c.error ?? c.conversation?.last_error}
			composer={c.composer}
			draft={c.draft}
			onDraftChange={c.setDraft}
			onSubmit={() => void c.submit()}
			canSubmit={c.canSubmit}
			queueing={!c.canSend && c.canQueue}
			onStop={c.live && c.cid ? () => void c.stopTurn() : undefined}
		/>
	);
	return (
		<section className="m-2 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card shadow-xs sm:m-3">
			<PageTitle>Chat</PageTitle>
			{c.permissionsOpen && (
				<PermissionsDialog pid={pid} onClose={() => c.setPermissionsOpen(false)} />
			)}
			<div className="flex min-h-0 flex-1">
				<ConversationSidebar
					open={c.historyOpen}
					onClose={() => c.setHistoryOpen(false)}
					items={c.conversations}
					selected={c.cid}
					busy={c.busy}
					loading={c.list.isPending}
					error={c.list.error?.message}
					onRetry={() => void c.list.refetch()}
					onSelect={(id) => c.select(id)}
					onDelete={c.setDeleting}
				/>
				<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto lg:flex-row lg:overflow-hidden">
					<div className="@container flex min-h-0 min-w-0 flex-1 flex-col">
						<header className="flex shrink-0 items-center justify-between gap-4 px-4 py-4 sm:px-9 sm:py-5">
							<div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
								<Button
									variant="ghost"
									size="sm"
									aria-label="History"
									aria-expanded={c.historyOpen}
									aria-controls={c.historyOpen ? 'chat-conversations' : undefined}
									onPress={() => c.setHistoryOpen(!c.historyOpen)}
								>
									<PanelLeft className="size-4" aria-hidden />
								</Button>
								<span className="truncate">{c.project.name}</span>
								<span aria-hidden>/</span>
								<span className="truncate font-medium text-foreground">
									{c.home ? 'New chat' : (c.conversation?.title ?? 'Conversation')}
								</span>
							</div>
							<div className="flex shrink-0 items-center gap-1">
								<Button
									variant="ghost"
									size="sm"
									isDisabled={c.creating}
									onPress={() => void c.openPane()}
									aria-pressed={c.paneOpen}
								>
									<Notebook className="size-4" aria-hidden />
									<span className="@max-3xl:sr-only">Notebook</span>
								</Button>
								<Button variant="ghost" size="sm" onPress={() => c.setPermissionsOpen(true)}>
									<ShieldCheck className="size-4" aria-hidden />
									<span className="@max-3xl:sr-only">Permissions</span>
								</Button>

								<Button
									variant="ghost"
									size="sm"
									onPress={() => c.select(null)}
									isDisabled={c.busy}
								>
									<Plus className="size-4" aria-hidden />
									<span className="@max-3xl:sr-only">New chat</span>
								</Button>
							</div>
						</header>
						{/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- Keyboard users need to focus this scroll container to navigate long replies. */}
						<section
							ref={c.scroll.transcript}
							onScroll={c.scroll.onScroll}
							onWheel={c.scroll.onWheel}
							aria-label="Chat history"
							tabIndex={0}
							className="min-h-0 flex-1 overflow-auto px-4 pb-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-10"
						>
							{c.detail.isError || (c.list.isError && !c.historyOpen) ? (
								<div
									role="alert"
									className="mx-auto mb-5 max-w-4xl rounded-lg border border-destructive/30 p-4 text-sm"
								>
									<p>{c.detail.error?.message ?? c.list.error?.message}</p>
									<Button
										className="mt-3"
										onPress={() => {
											if (c.cid) void c.detail.refetch();
											void c.list.refetch();
										}}
									>
										Retry
									</Button>
								</div>
							) : null}
							{c.cid && c.detail.isPending ? (
								<output className="block py-10 text-center text-sm text-muted-foreground">
									Loading conversation…
								</output>
							) : null}
							{c.home ? (
								<ChatEmptyState
									project={c.project}
									capabilities={c.capabilities}
									composer={composerElement}
									onPickPrompt={(prompt) => c.pickPrompt(prompt)}
								/>
							) : (
								<div
									ref={c.scroll.content}
									role="log"
									aria-label="Conversation"
									aria-live="polite"
									className="mx-auto max-w-3xl space-y-6 pt-6"
								>
									<ChatMessages
										messages={c.messages}
										onReuse={(text) => c.pickPrompt(text)}
										canReuse={!c.draft}
										onDecide={c.decidePermission}
										onInspect={c.setInspect}
										inspecting={c.inspect}
									/>
									{!c.busy ? (
										<ContinuationControls
											continuation={c.conversation?.continuation}
											busy={c.busy}
											onResume={c.resume}
											onDismiss={c.dismissTask}
										/>
									) : null}
									{c.busy ? (
										<ChatProgress calls={c.latestTools} writing={c.live && c.latestWriting} />
									) : null}
									{c.queue.length > 0 ? (
										<section
											aria-label="Queued messages"
											className="rounded-lg border bg-muted/40 p-3 text-sm"
										>
											<p className="mb-2 text-xs font-medium text-muted-foreground">
												Queued · sends after this response
											</p>
											<ul className="space-y-2">
												{c.queue.map((item, index) => (
													<li key={item.id} className="flex items-start justify-between gap-3">
														<span className="min-w-0 whitespace-pre-wrap break-words">
															{item.text}
														</span>
														<Button
															variant="ghost"
															size="sm"
															aria-label={`Remove queued message ${index + 1}`}
															onPress={() => c.removeQueued(item.id)}
														>
															Remove
														</Button>
													</li>
												))}
											</ul>
										</section>
									) : null}
								</div>
							)}
						</section>
						{/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */}
						{!c.home ? (
							<div className="max-h-[45%] shrink-0 overflow-y-auto px-4 pb-4 pt-2 sm:px-10">
								{composerElement}
							</div>
						) : null}
					</div>
					{(c.inspected || c.inspectMissing || c.paneOpen) && c.cid ? (
						<PaneDivider width={c.paneWidth} onWidth={c.setPaneWidth} />
					) : null}
					{c.inspectMissing && c.cid ? (
						<MissingInspector width={c.paneWidth} onClose={() => c.setInspect(null)} />
					) : c.inspected && c.cid ? (
						<ContextInspector
							key={c.inspected.id}
							pid={pid}
							entry={c.inspected}
							notebooks={c.notebooks}
							permalink={c.inspectPermalink}
							width={c.paneWidth}
							onShowNotebook={(id) => void c.showNotebook(id)}
							onClose={() => c.setInspect(null)}
						/>
					) : c.paneOpen && c.cid ? (
						<NotebookPane
							key={c.cid}
							pid={pid}
							workingNotebook={c.conversation?.working_notebook}
							notebooks={c.notebooks}
							busy={c.busy}
							width={c.paneWidth}
							onChange={c.setWorkingNotebook}
							onClose={() => c.setPaneOpen(false)}
						/>
					) : null}
				</div>
			</div>
			<ConfirmDialog
				isOpen={Boolean(c.deleting)}
				onClose={() => c.setDeleting(null)}
				title="Delete conversation"
				description="This removes the saved conversation from your history."
				confirmLabel="Delete"
				variant="danger"
				isPending={c.removing}
				onConfirm={() => void c.deleteSelected()}
			/>
		</section>
	);
}

export function ChatPage() {
	const { pid = '' } = useParams();
	return <ProjectChat key={pid} pid={pid} />;
}

export default ChatPage;
