import { z } from 'zod';

export const PreviewAutomationPolicySchema = z.strictObject({
	mode: z.enum(['sticky', 'commits']).default('sticky'),
	keep: z.number().int().min(1).max(25).default(5),
	eager: z.boolean().default(true),
	idle_days: z.number().int().min(1).max(30).optional(),
});
export type PreviewAutomationPolicy = z.infer<typeof PreviewAutomationPolicySchema>;
