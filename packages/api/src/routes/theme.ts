import { createRoute } from '@hono/zod-openapi';
import { createApp, jsonContent, ok } from '../shared';
import {
	DEFAULT_THEME_CONFIG,
	ThemeConfigSchema,
	ThemeResponseSchema,
} from '@marimo-hub/core/theme';

const app = createApp();

app.openapi(
	createRoute({
		method: 'get',
		path: '/theme',
		operationId: 'theme',
		tags: ['System'],
		summary: 'Get public deployment branding',
		security: [],
		responses: {
			200: jsonContent(ThemeResponseSchema, 'Deployment branding, available before sign-in'),
		},
	}),
	(c) => {
		c.header('Cache-Control', 'no-store');
		return ok(c, ThemeConfigSchema.parse(c.get('deps').theme ?? DEFAULT_THEME_CONFIG));
	},
);

export default app;
