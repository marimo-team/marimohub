import { vi } from 'vitest';
import { RuntimeCaptureClient } from '@marimo-hub/core/runtime-capture';

/** API tests use sandbox files directly; process coordination has Linux integration coverage. */
export function mockRuntimeCapture() {
	const checkpoints = new Map<string, { token: string; directory: string }>();
	vi.spyOn(RuntimeCaptureClient.prototype, 'prepare').mockImplementation(
		async function (this: RuntimeCaptureClient, directory) {
			const checkpoint = { token: crypto.randomUUID(), directory };
			checkpoints.set((this as unknown as { sandboxId: string }).sandboxId, checkpoint);
			return checkpoint;
		},
	);
	vi.spyOn(RuntimeCaptureClient.prototype, 'status').mockImplementation(
		async function (this: RuntimeCaptureClient) {
			return {
				ok: true,
				state: 'stopped',
				token: checkpoints.get((this as unknown as { sandboxId: string }).sandboxId)?.token,
			};
		},
	);
	vi.spyOn(RuntimeCaptureClient.prototype, 'resume').mockResolvedValue();
	vi.spyOn(RuntimeCaptureClient.prototype, 'commitStop').mockResolvedValue();
}
