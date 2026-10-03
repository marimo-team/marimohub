import { toast } from 'sonner';
import { copyText } from '@/lib/clipboard';

export async function copyPreviewLink(url: string): Promise<void> {
	if (await copyText(url)) toast.success('Preview link copied');
}
