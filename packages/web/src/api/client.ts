import {
	createApiClient,
	apiData,
	apiDataWithResponse,
	apiErrorFromResponse,
	ApiRequestError,
} from '@marimo-hub/client';
import { appBasePath } from '@/lib/basePath';

const basePath = appBasePath().replace(/\/+$/, '');
export const apiClient = createApiClient({ baseUrl: `${window.location.origin}${basePath}` });

export { apiData, apiDataWithResponse, apiErrorFromResponse, ApiRequestError };
export type {
	ApiError,
	ApiResponse,
	ApiRequestErrorCode,
	ServerErrorCode,
} from '@marimo-hub/client';
