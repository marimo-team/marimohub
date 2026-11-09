import { useEffect } from 'react';

const connections = new Map<string, { link: HTMLLinkElement; users: number }>();

export function useSandboxPreconnect(sandboxUrl: string | undefined) {
	const origin = sandboxUrl ? new URL(sandboxUrl, window.location.href).origin : undefined;
	useEffect(() => {
		if (!origin || origin === window.location.origin) return;
		let connection = connections.get(origin);
		if (!connection) {
			const link = document.createElement('link');
			link.rel = 'preconnect';
			link.href = origin;
			// No crossorigin: the iframe navigation is credentialed and only reuses a credentialed socket.
			document.head.append(link);
			connection = { link, users: 0 };
			connections.set(origin, connection);
		}
		connection.users += 1;
		return () => {
			connection.users -= 1;
			if (connection.users === 0) {
				connection.link.remove();
				connections.delete(origin);
			}
		};
	}, [origin]);
}
