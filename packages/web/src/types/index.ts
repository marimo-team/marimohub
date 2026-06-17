// The API response shapes are defined ONCE, in the core zod schemas, surfaced
// through the OpenAPI document, and code-generated into `@marimo-hub/client`.
// The web consumes those generated types here instead of re-declaring them, so
// a field added in core flows through to the UI without a parallel hand-written
// copy drifting out of sync.

import type {
	SnapshotProjectEntry,
	SnapshotNotebookEntry,
	NotebookMeta as ClientNotebookMeta,
	Session as ClientSession,
	ApiResponse as ClientApiResponse,
	ApiError as ClientApiError,
} from '@marimo-hub/client';

// Aliases onto the generated client types. Names kept stable so existing web
// imports (`ProjectSummary`, `NotebookEntry`, ...) continue to work.
export type ProjectSummary = SnapshotProjectEntry;
export type NotebookEntry = SnapshotNotebookEntry;
export type NotebookMeta = ClientNotebookMeta;
export type Session = ClientSession;
export type ApiResponse<T> = ClientApiResponse<T>;
export type ApiError = ClientApiError;

// Web-local: the `/api/me` payload. The OpenAPI doc inlines this response (no
// named `User` component), so the generated client exposes no equivalent type.
// Kept here as the single web-side declaration of the authenticated-user shape.
export interface User {
	id: string;
	email: string;
	logoutUrl?: string | null;
}
