import {
	createApiClient,
	apiData,
	apiDataWithResponse,
	apiErrorFromResponse,
	ApiRequestError,
} from '@marimo-hub/client';
import { appBasePath } from '@/lib/basePath';
import { consumeInitialRequest } from '@/lib/initialRequests';

const basePath = appBasePath().replace(/\/+$/, '');
export const apiClient = createApiClient({ baseUrl: `${window.location.origin}${basePath}` });
apiClient.use({
	async onRequest({ request }) {
		if (request.method === 'GET') return consumeInitialRequest(request.url, request.signal);
	},
});

export { apiData, apiDataWithResponse, apiErrorFromResponse, ApiRequestError };
export type {
	ApiError,
	ApiResponse,
	ApiRequestErrorCode,
	ServerErrorCode,
} from '@marimo-hub/client';
