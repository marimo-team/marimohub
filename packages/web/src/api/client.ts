// The fetch wrapper + error type now live in the generated API client package,
// derived from the OpenAPI document. Re-exported here so existing imports
// (`./client`) keep working.
export { apiFetch, ApiRequestError } from '@marimo-hub/client';
export type { ApiError, ApiResponse } from '@marimo-hub/client';
