import { z } from 'zod';

export const DeepLinkSlugSchema = z
	.string()
	.min(1)
	.max(63)
	.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?![\s\S])/);
