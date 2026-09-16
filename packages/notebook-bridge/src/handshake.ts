import { HANDSHAKE_TIMEOUT_MS } from './protocol';

export function createHandshakeRetry(send: () => void, expired: () => void) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const stop = () => {
		clearTimeout(timer);
		timer = undefined;
	};
	return {
		stop,
		start() {
			stop();
			const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
			let attempts = 0;
			const retry = () => {
				if (Date.now() >= deadline) {
					stop();
					expired();
					return;
				}
				send();
				timer = setTimeout(retry, Math.min(100 * 2 ** attempts++, 1_000, deadline - Date.now()));
			};
			retry();
		},
	};
}
