import { ChevronDown, Cpu, RefreshCw, Square, Users, UserRound } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button, Popover, StatusDot } from '@/components/ui';
import { SESSION_STATUS } from '@/components/ui/sessionStatus';
import { SessionDetails } from '@/components/ui/SessionDetails';
import { ComputeProfileIndicator } from '@/components/Notebook/ComputeProfileIndicator';
import type { ComputeProfile } from '@/components/Notebook/computeProfiles';
import type { Session } from '@/types';

interface SessionControlProps {
	session?: Session | null;
	profiles: ComputeProfile[];
	selectedProfileName?: string;
	storedName?: string;
	allowOverride: boolean;
	hint?: string;
	isProvisioning: boolean;
	error?: string;
	onStop: () => void;
	onRestart?: () => void;
}

export function SessionControl({
	session,
	profiles,
	selectedProfileName,
	storedName,
	allowOverride,
	hint,
	isProvisioning,
	error,
	onStop,
	onRestart,
}: SessionControlProps) {
	const status = SESSION_STATUS[
		error ? 'failed' : (session?.status ?? (isProvisioning ? 'starting' : 'terminated'))
	] ?? { label: 'Unknown', className: 'bg-muted-foreground' };
	const sharing = session?.ephemeral
		? 'Temporary'
		: session?.mode === 'edit' && session.editor_sandbox_sharing === 'shared'
			? 'Shared'
			: undefined;
	const unavailable =
		allowOverride && storedName && !profiles.some((profile) => profile.name === storedName);
	const SessionIcon = sharing === 'Shared' ? Users : sharing === 'Temporary' ? UserRound : Cpu;
	return (
		<Popover
			label={`Session ${status.label}${sharing ? ` · ${sharing}` : ''} — details`}
			tooltip="Session details and controls"
			placement="bottom end"
			trigger={
				<>
					<span className="relative flex">
						<SessionIcon className="size-4 md:hidden" />
						<StatusDot
							pulse={status.pulse}
							className={cn(
								status.className,
								'max-md:absolute max-md:-right-1 max-md:-top-1 max-md:ring-2 max-md:ring-background',
							)}
							aria-hidden="true"
						/>
					</span>
					<span aria-live="polite" className="max-md:sr-only">
						{status.label}
					</span>
					{sharing && (
						<span className="border-l pl-2 text-muted-foreground max-md:sr-only">{sharing}</span>
					)}
					<ChevronDown className="size-3 shrink-0 max-md:hidden" />
				</>
			}
			triggerClassName="h-8 shrink-0 justify-center gap-2 rounded-md border border-input px-2 text-xs hover:bg-muted max-md:size-11 max-md:gap-0 max-md:px-0"
		>
			{({ close }) => (
				<div className="flex max-w-[calc(100vw-3rem)] flex-col gap-3">
					{session ? (
						<SessionDetails
							session={session}
							label={status.label}
							profiles={profiles}
							selectedProfileName={selectedProfileName}
						/>
					) : (
						<ComputeProfileIndicator
							profiles={profiles}
							storedName={storedName}
							allowOverride={allowOverride}
							hint={hint}
						/>
					)}
					{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
					{session && unavailable && (
						<p className="text-xs text-amber-700 dark:text-amber-400">
							The selected profile “{storedName}” is unavailable. The default will be used for new
							sessions.
						</p>
					)}
					{sharing === 'Shared' && (
						<p className="text-xs text-muted-foreground">
							Project editors can view and edit this session.
						</p>
					)}
					{sharing === 'Temporary' && (
						<p className="text-xs text-muted-foreground">
							This session is isolated. Changes won’t be saved.
						</p>
					)}
					{error && <p className="text-xs text-destructive">{error}</p>}
					{session?.can.stop && (
						<div className="flex flex-wrap justify-end gap-2 border-t pt-2">
							{onRestart && (
								<Button
									variant="ghost"
									size="sm"
									onPress={() => {
										close();
										onRestart();
									}}
								>
									<RefreshCw className="size-3" />
									Restart
								</Button>
							)}
							<Button
								variant="ghost"
								size="sm"
								className="text-destructive hover:bg-destructive/10 hover:text-destructive"
								onPress={() => {
									close();
									onStop();
								}}
							>
								<Square className="size-3" />
								{sharing === 'Shared' ? 'Stop shared session…' : 'Stop'}
							</Button>
						</div>
					)}
				</div>
			)}
		</Popover>
	);
}
