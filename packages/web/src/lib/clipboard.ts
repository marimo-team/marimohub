import { toast } from 'sonner';

export async function copyText(value: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(value);
		return true;
	} catch {
		toast.error('Could not copy to clipboard');
		return false;
	}
}
