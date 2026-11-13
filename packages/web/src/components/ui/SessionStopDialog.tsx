import { useState, useSyncExternalStore } from 'react';
import { currentStopDecision, decideStop, subscribeStopDecision } from '@/api/sessionStop';
import { DialogModal } from './Dialog';
import { Button } from './Button';
import type { Session } from '@/types';

function StopChoice({ session }: { session: Session }) {
	const [confirmForce, setConfirmForce] = useState(false);
	const stop = session.stop!;
	const running = stop.runtime_state === 'running';
	const guidance =
		stop.failure?.code === 'CAPTURE_UNSUPPORTED'
			? 'This runtime does not support a safe stop. Keep it running or explicitly force stop.'
			: stop.failure?.code === 'SOURCE_MISSING'
				? 'The notebook source file is missing. Restore it in the session, then retry.'
				: stop.failure?.code === 'ARTIFACT_INVALID'
					? 'A required notebook file is not a regular file. Fix the file, then retry.'
					: stop.failure?.code === 'ARTIFACT_TOO_LARGE'
						? 'A required save file exceeds the storage limit. Reduce its size, then retry.'
						: 'Storage or runtime capture could not be confirmed. Retry when the service is available.';
	return (
		<DialogModal
			isOpen
			onClose={() => decideStop('keep')}
			title={confirmForce ? 'Force stop this session?' : 'Changes could not be saved'}
			width="sm"
		>
			<div className="flex flex-col gap-4">
				<p className="text-sm text-muted-foreground">
					{confirmForce
						? 'Changes that have not reached durable storage may be permanently lost. Force stop shuts down the session without another save.'
						: running
							? 'Your session is still running. Retry saving, or keep editing and try again later.'
							: 'The save or runtime state is uncertain. The sandbox has been retained. Retry to check again before stopping.'}
				</p>
				{session.last_durable_capture && (
					<p className="text-sm">
						Last durable save: {new Date(session.last_durable_capture.at).toLocaleString()}
					</p>
				)}
				{!confirmForce && stop.failure && (
					<p className="text-xs text-muted-foreground">{guidance}</p>
				)}
				<div className="flex flex-wrap justify-end gap-2">
					<Button
						variant="ghost"
						onPress={() => (confirmForce ? setConfirmForce(false) : decideStop('keep'))}
					>
						{confirmForce ? 'Cancel' : running ? 'Keep running' : 'Leave session retained'}
					</Button>
					{!confirmForce && (
						<Button
							onPress={() => decideStop('retry')}
							isDisabled={stop.failure?.code === 'CAPTURE_UNSUPPORTED'}
						>
							Retry save
						</Button>
					)}
					{session.can.stop && (
						<Button
							variant="danger"
							onPress={() => (confirmForce ? decideStop('force') : setConfirmForce(true))}
						>
							{confirmForce ? 'Force stop and discard changes' : 'Force stop…'}
						</Button>
					)}
				</div>
			</div>
		</DialogModal>
	);
}

export function SessionStopDialog() {
	const request = useSyncExternalStore(subscribeStopDecision, currentStopDecision);
	return request ? <StopChoice key={request.session.stop!.id} session={request.session} /> : null;
}
