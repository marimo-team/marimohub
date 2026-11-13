import type { RuntimeCheckpoint } from './runtimeCapture';
import type { CommitSessionResult } from '../content/NotebookService';

export type CaptureFailureCode =
	| 'SOURCE_UNAVAILABLE'
	| 'ARTIFACT_TOO_LARGE'
	| 'ARTIFACT_INVALID'
	| 'CAPTURE_UNSUPPORTED'
	| 'SOURCE_MISSING'
	| 'SOURCE_NOT_COMMITTED'
	| 'RUNTIME_CAPTURE_UNAVAILABLE'
	| 'CAPTURE_RECEIPT_FAILED'
	| 'PUBLICATION_UNCERTAIN';

export type CriticalCaptureResult =
	| { status: 'durable'; publication: CommitSessionResult; capturedAt: string }
	| { status: 'not_required'; reason: 'discard' | 'remote_source' }
	| {
			status: 'failed' | 'uncertain';
			code: CaptureFailureCode;
			retryable: boolean;
			/** Internal diagnostics; API callers must use the safe code instead. */
			cause: unknown;
	  };

export type WorkspaceCaptureResult =
	| { status: 'skipped' | 'captured' }
	| { status: 'failed'; cause: unknown };

export interface SessionCaptureResult {
	critical: CriticalCaptureResult;
	workspace: WorkspaceCaptureResult;
	runtime?: RuntimeCheckpoint;
	runtimeState?: 'running' | 'paused' | 'unknown';
}
