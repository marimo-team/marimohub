import { ARTIFACT_ID, LAUNCHER, WHEEL_BASE64, WHEEL_NAME } from './runtime.generated';

export function notebookBridgeRuntime() {
	const bytes = Uint8Array.from(atob(WHEEL_BASE64), (value) => value.charCodeAt(0));
	return {
		launcher: 'marimo-bridge.py',
		files: [
			{ name: 'marimo-bridge.py', content: LAUNCHER },
			{ name: WHEEL_NAME, content: bytes },
			{
				name: 'install.json',
				content: JSON.stringify({ identity: ARTIFACT_ID, wheel: WHEEL_NAME }),
			},
		],
	};
}
