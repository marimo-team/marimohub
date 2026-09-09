import { Tab, TabList, TabPanel, Tabs } from 'react-aria-components';
import { useCapabilitiesQuery } from '@/api/hooks';
import { Button, CopyField, DialogModal, LinkButton } from '@/components/ui';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { DOCS_MCP_URL } from '@/lib/links';

const clients = ['Cursor', 'Claude', 'Codex', 'OpenCode', 'Other'] as const;
const panelClassName =
	'flex flex-col gap-3 pt-4 outline-none focus-visible:ring-2 focus-visible:ring-ring';

function OpenCodeConfig({ url }: { url: string }) {
	const { copied, copy } = useCopyToClipboard();
	const config = JSON.stringify({ mcp: { marimohub: { type: 'remote', url } } }, null, 2);
	return (
		<div className="flex flex-col gap-2">
			<textarea
				aria-label="OpenCode configuration"
				readOnly
				value={config}
				rows={8}
				onFocus={(event) => event.target.select()}
				className="w-full resize-none rounded-md border border-input bg-muted/40 p-3 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
			/>
			<Button className="self-end" size="sm" onPress={() => void copy(config)}>
				{copied ? 'Copied' : 'Copy configuration'}
			</Button>
		</div>
	);
}

export function McpDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
	const { data: capabilities, isPending, isError } = useCapabilitiesQuery(isOpen);
	const url = capabilities?.mcp?.available ? capabilities.mcp.url : null;
	// Single quotes keep URL characters from being interpreted by POSIX shells.
	const shellUrl = url ? `'${url.replaceAll("'", "'\\''")}'` : '';
	const cursorConfig = url
		? btoa(
				Array.from(new TextEncoder().encode(JSON.stringify({ url })), (byte) =>
					String.fromCharCode(byte),
				).join(''),
			)
		: '';

	return (
		<DialogModal isOpen={isOpen} onClose={onClose} title="Connect with MCP" width="lg">
			<div className="flex flex-col gap-4 text-sm">
				<p className="text-muted-foreground">
					Connect your AI tools to read, edit, and run your marimohub notebooks.
				</p>
				{url ? (
					<>
						<CopyField label="MCP server URL" value={url} />
						<Tabs defaultSelectedKey="Cursor">
							<TabList aria-label="MCP client" className="flex overflow-x-auto border-b">
								{clients.map((client) => (
									<Tab
										key={client}
										id={client}
										className="shrink-0 cursor-pointer border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground outline-none selected:border-primary selected:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
									>
										{client}
									</Tab>
								))}
							</TabList>
							<TabPanel id="Cursor" className={panelClassName}>
								<p>Add the server to Cursor, then connect it to sign in.</p>
								<LinkButton
									className="self-start"
									variant="primary"
									to={`cursor://anysphere.cursor-deeplink/mcp/install?name=marimohub&config=${encodeURIComponent(cursorConfig)}`}
								>
									Add to Cursor
								</LinkButton>
								<p className="text-muted-foreground">
									For manual setup, add a remote MCP server in Cursor settings with the URL above.
								</p>
							</TabPanel>
							<TabPanel id="Claude" className={panelClassName}>
								<p>Run this command in your terminal to add the server to Claude Code:</p>
								<CopyField
									label="Claude Code command"
									value={`claude mcp add --transport http --scope user marimohub ${shellUrl}`}
									hideLabel
								/>
								<p>
									In Claude Code, run <code>/mcp</code> and select marimohub to authenticate.
								</p>
								<p className="text-muted-foreground">
									For Claude web or desktop, add a custom connector in Settings → Connectors with
									the URL above.
								</p>
							</TabPanel>
							<TabPanel id="Codex" className={panelClassName}>
								<p>Run this command in your terminal to add the server:</p>
								<CopyField
									label="Codex command"
									value={`codex mcp add marimohub --url ${shellUrl}`}
									hideLabel
								/>
								<p>Then sign in through your browser:</p>
								<CopyField
									label="Codex login command"
									value="codex mcp login marimohub"
									hideLabel
								/>
							</TabPanel>
							<TabPanel id="OpenCode" className={panelClassName}>
								<p>
									Merge this server configuration into your <code>opencode.json</code>:
								</p>
								<OpenCodeConfig url={url} />
								<p>Then run this command to sign in:</p>
								<CopyField
									label="OpenCode login command"
									value="opencode mcp auth marimohub"
									hideLabel
								/>
							</TabPanel>
							<TabPanel id="Other" className={panelClassName}>
								<p>
									Add a remote MCP server named <code>marimohub</code> with the URL above.
								</p>
								<p>
									Select Streamable HTTP as the transport and OAuth as the authentication method.
									Connect the server to sign in through your browser.
								</p>
								<p className="text-muted-foreground">
									Your client must support OAuth with dynamic client registration. Manually created
									API tokens cannot authenticate to this MCP server.
								</p>
							</TabPanel>
						</Tabs>
						<p className="border-t pt-4 text-xs text-muted-foreground">
							When you sign in, choose which actions and projects the client can access. You can
							revoke access from API tokens.
						</p>
					</>
				) : (
					<output className="text-muted-foreground">
						{isError
							? 'Could not load MCP settings. Close this dialog and try again.'
							: isPending
								? 'Loading MCP settings…'
								: 'MCP is not available on this deployment.'}
					</output>
				)}
				<a
					href={DOCS_MCP_URL}
					target="_blank"
					rel="noreferrer"
					className="text-xs text-primary underline-offset-2 hover:underline"
				>
					MCP documentation
				</a>
			</div>
		</DialogModal>
	);
}
