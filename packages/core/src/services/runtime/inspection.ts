import type { z } from 'zod';
import type { Bucket } from '../../ports/bucket';
import { logOperationalError } from '../../operationalLog';
import { readStored } from '../../schema';

// Diagnostic reads may be incomplete; admission and maintenance must still fail closed.
export async function readForInspection<T>(
	bucket: Bucket,
	key: string,
	schema: z.ZodType<T>,
	operation: string,
): Promise<T | null> {
	try {
		const object = await bucket.get(key);
		return object ? await readStored(schema, object, key) : null;
	} catch (error) {
		logOperationalError('stored_object_skipped', { operation, object: key }, error);
		return null;
	}
}
