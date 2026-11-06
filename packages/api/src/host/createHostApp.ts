import { createHostApp as createHostProtocolApp } from '@marimo-hub/host-protocol';
import type { HostAppEnv } from '@marimo-hub/host-protocol';
import type { Hono } from 'hono';
import type { ApiDeps } from '../context';
import { describeError, logEvent } from '../log';
import { createHubHostPlatform } from './platform';

export const HOST_PREFIX = '/api/host/v1';

export function createHostApp(deps: ApiDeps): Hono<HostAppEnv> {
	return createHostProtocolApp(createHubHostPlatform(deps), {
		realm: 'marimohub-host',
		onError: (error) =>
			logEvent({ level: 'error', event: 'host_request_failed', error: describeError(error) }),
	});
}
