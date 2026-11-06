import { PreviewAutomationPolicySchema } from '@marimo-hub/core/preview-policy';
import type { PreviewAutomationPolicy } from '@marimo-hub/core/preview-policy';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, DialogModal } from '@/components/ui';
import { appBasePath } from '@/lib/basePath';
import { copyText } from '@/lib/clipboard';
import { previewWorkflow } from './previewWorkflow';

const defaults = PreviewAutomationPolicySchema.parse({});

export function PreviewActionSetup({ pid, nid }: { pid: string; nid: string }) {
	const [open, setOpen] = useState(false);
	const [mode, setMode] = useState<PreviewAutomationPolicy['mode']>(defaults.mode);
	const [keep, setKeep] = useState(String(defaults.keep));
	const [eager, setEager] = useState(defaults.eager);
	const [idle, setIdle] = useState('');
	const policy = PreviewAutomationPolicySchema.safeParse({
		mode,
		keep: mode === 'sticky' ? defaults.keep : Number(keep),
		eager,
		...(idle ? { idle_days: Number(idle) } : {}),
	});
	const workflow = policy.success
		? previewWorkflow({
				hubUrl: `${window.location.origin}${appBasePath()}`,
				projectId: pid,
				notebookId: nid,
				...policy.data,
			})
		: '';

	return (
		<>
			<Button variant="default" onPress={() => setOpen(true)}>
				Set up GitHub Action
			</Button>
			<DialogModal isOpen={open} onClose={() => setOpen(false)} title="Set up GitHub Action">
				<div className="space-y-4">
					<label className="block space-y-1 text-sm">
						Preview mode
						<select
							className="block w-full rounded border bg-background p-2"
							value={mode}
							onChange={(event) => setMode(event.target.value as 'sticky' | 'commits')}
						>
							<option value="sticky">Follow branch HEAD with one stable link</option>
							<option value="commits">Keep the latest commit previews</option>
						</select>
					</label>
					{mode === 'commits' && (
						<label className="block space-y-1 text-sm">
							Commits to keep
							<input
								className="block w-full rounded border bg-background p-2"
								type="number"
								min={1}
								max={25}
								aria-label="Commits to keep"
								value={keep}
								onChange={(event) => setKeep(event.target.value)}
							/>
						</label>
					)}
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							aria-label="Prepare code automatically"
							checked={eager}
							onChange={(event) => setEager(event.target.checked)}
						/>
						Prepare code automatically
					</label>
					<p className="text-sm text-muted-foreground">
						When disabled, code prepares on the first visit. Compute always starts on demand.
					</p>
					<label className="block space-y-1 text-sm">
						Expire after inactive days (optional)
						<input
							className="block w-full rounded border bg-background p-2"
							type="number"
							min={1}
							max={30}
							aria-label="Expire after inactive days (optional)"
							value={idle}
							onChange={(event) => setIdle(event.target.value)}
							placeholder="Until PR closes"
						/>
					</label>
					<p className="text-sm text-muted-foreground">
						New commits reset the timeout. Closing or merging the PR retires its previews.
					</p>
					<ol className="list-decimal space-y-2 pl-5 text-sm">
						<li>
							From your account menu, create a manager or admin API token for this project with{' '}
							<code>preview.manage</code>.
						</li>
						<li>
							Add the token as a GitHub Actions repository secret named <code>MARIMOHUB_TOKEN</code>
							.
						</li>
						<li>
							Save this workflow as <code>.github/workflows/notebook-previews.yml</code> in the
							connected repository.
						</li>
					</ol>
					<p className="text-sm text-muted-foreground">
						Previews run PR code with this notebook’s integrations and secrets. Fork PRs are
						skipped.
					</p>
					<p className="text-sm text-muted-foreground">
						The Action is pinned to a commit. Review a new revision before updating the pin. The hub
						must be reachable from the runner.
					</p>
					<pre
						className="max-h-64 overflow-auto rounded border bg-muted p-3 text-xs"
						aria-label="GitHub Actions workflow"
					>
						{workflow}
					</pre>
					<Button
						isDisabled={!policy.success}
						onPress={() =>
							void copyText(workflow).then((copied) => {
								if (copied) toast.success('Workflow copied');
							})
						}
					>
						Copy workflow
					</Button>
				</div>
			</DialogModal>
		</>
	);
}
