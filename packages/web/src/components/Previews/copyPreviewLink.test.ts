import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { copyPreviewLink } from './copyPreviewLink';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe('copyPreviewLink', () => {
	it('reports unavailable clipboard access without throwing', async () => {
		vi.stubGlobal('navigator', {});
		await expect(copyPreviewLink('https://hub.example/preview')).resolves.toBeUndefined();
		expect(toast.error).toHaveBeenCalledWith('Could not copy to clipboard');
		expect(toast.success).not.toHaveBeenCalled();
	});

	it('reports rejected clipboard access', async () => {
		vi.stubGlobal('navigator', {
			clipboard: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) },
		});
		await copyPreviewLink('https://hub.example/preview');
		expect(toast.error).toHaveBeenCalledWith('Could not copy to clipboard');
		expect(toast.success).not.toHaveBeenCalled();
	});

	it('copies the share URL and reports success', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal('navigator', { clipboard: { writeText } });
		await copyPreviewLink('https://hub.example/preview');
		expect(writeText).toHaveBeenCalledWith('https://hub.example/preview');
		expect(toast.success).toHaveBeenCalledWith('Preview link copied');
	});
});
