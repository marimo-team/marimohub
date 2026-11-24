import { useCallback, useEffect, useRef, useState } from 'react';
import {
	heartbeatPublicAppVisit,
	isPublicAppNotFound,
	leavePublicAppVisit,
	pollPublicAppVisit,
	PublicAppApiError,
	startPublicAppVisit,
} from '@/api/publicApps';

export interface PublicAppVisitState {
	sandboxUrl: string | null;
	isProvisioning: boolean;
	error: { code: string; message: string } | null;
	ended: 'revoked' | 'ended' | null;
	start: () => void;
}

export function usePublicAppVisit(slug: string, defaultHeartbeatSeconds = 30): PublicAppVisitState {
	const [sandboxUrl, setSandboxUrl] = useState<string | null>(null);
	const [isProvisioning, setIsProvisioning] = useState(true);
	const [error, setError] = useState<{ code: string; message: string } | null>(null);
	const [ended, setEnded] = useState<'revoked' | 'ended' | null>(null);
	const [attempt, setAttempt] = useState(0);

	const tokenRef = useRef<string | undefined>(undefined);
	const heartbeatIntervalRef = useRef<number>(defaultHeartbeatSeconds);

	const start = useCallback(() => {
		setError(null);
		setEnded(null);
		setSandboxUrl(null);
		setIsProvisioning(true);
		setAttempt((count) => count + 1);
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		let heartbeatTimer: number | undefined;
		let active = true;

		const scheduleHeartbeat = () => {
			if (!active) return;
			const intervalMs = Math.max(5_000, heartbeatIntervalRef.current * 1000);
			heartbeatTimer = window.setTimeout(() => {
				void runHeartbeat();
			}, intervalMs);
		};

		const runHeartbeat = async () => {
			const token = tokenRef.current;
			if (!active || !token) return;
			try {
				const next = await heartbeatPublicAppVisit(token, controller.signal);
				if (!active) return;
				tokenRef.current = next.visit_token;
				heartbeatIntervalRef.current = next.heartbeat_interval_seconds;
				if (next.status === 'running' && next.sandbox_url) {
					setSandboxUrl(next.sandbox_url);
					scheduleHeartbeat();
				} else if (next.status === 'ended') {
					setSandboxUrl(null);
					setEnded('ended');
				} else {
					scheduleHeartbeat();
				}
			} catch (err) {
				if (!active || controller.signal.aborted) return;
				if (isPublicAppNotFound(err)) {
					tokenRef.current = undefined;
					setSandboxUrl(null);
					setEnded('revoked');
					return;
				}
				scheduleHeartbeat();
			}
		};

		const boot = async () => {
			try {
				let visit = await startPublicAppVisit(slug, tokenRef.current, controller.signal);
				if (!active) return;
				tokenRef.current = visit.visit_token;
				heartbeatIntervalRef.current = visit.heartbeat_interval_seconds;

				const deadline = Date.now() + visit.startup_timeout_seconds * 1000;
				while (visit.status === 'starting' && Date.now() < deadline) {
					visit = await pollPublicAppVisit(visit.visit_token, 15, controller.signal);
					if (!active) return;
					tokenRef.current = visit.visit_token;
					heartbeatIntervalRef.current = visit.heartbeat_interval_seconds;
				}

				if (!active) return;
				if (visit.status === 'running' && visit.sandbox_url) {
					setSandboxUrl(visit.sandbox_url);
					setIsProvisioning(false);
					scheduleHeartbeat();
				} else {
					setSandboxUrl(null);
					setIsProvisioning(false);
					setEnded('ended');
				}
			} catch (err) {
				if (!active || controller.signal.aborted) return;
				setSandboxUrl(null);
				setIsProvisioning(false);
				if (isPublicAppNotFound(err)) {
					tokenRef.current = undefined;
					setEnded('revoked');
					return;
				}
				if (err instanceof PublicAppApiError) {
					setError({ code: err.code, message: err.message });
				} else {
					setError({ code: 'START_FAILED', message: 'Unable to open this app right now.' });
				}
			}
		};

		const onPageHide = () => {
			if (tokenRef.current) leavePublicAppVisit(tokenRef.current);
		};
		window.addEventListener('pagehide', onPageHide);
		void boot();

		return () => {
			active = false;
			controller.abort();
			if (heartbeatTimer !== undefined) window.clearTimeout(heartbeatTimer);
			window.removeEventListener('pagehide', onPageHide);
			if (tokenRef.current) leavePublicAppVisit(tokenRef.current);
		};
	}, [slug, attempt]);

	return { sandboxUrl, isProvisioning, error, ended, start };
}
