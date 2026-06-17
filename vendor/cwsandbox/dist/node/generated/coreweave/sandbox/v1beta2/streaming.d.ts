import { ServiceType } from "@protobuf-ts/runtime-rpc";
import type { BinaryWriteOptions } from "@protobuf-ts/runtime";
import type { IBinaryWriter } from "@protobuf-ts/runtime";
import type { BinaryReadOptions } from "@protobuf-ts/runtime";
import type { IBinaryReader } from "@protobuf-ts/runtime";
import type { PartialMessage } from "@protobuf-ts/runtime";
import { MessageType } from "@protobuf-ts/runtime";
import { Timestamp } from "../../../google/protobuf/timestamp.js";
/**
 * ExecStreamRequest is sent by client to initiate exec or send stdin data.
 * The first message must be an init message, followed by optional stdin,
 * resize, and close messages.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.ExecStreamRequest
 */
export interface ExecStreamRequest {
    /**
     * @generated from protobuf oneof: request
     */
    request: {
        oneofKind: "init";
        /**
         * Initial request to start command execution.
         * Must be the first message sent on the stream.
         *
         * @generated from protobuf field: coreweave.sandbox.v1beta2.ExecStreamInit init = 1
         */
        init: ExecStreamInit;
    } | {
        oneofKind: "stdin";
        /**
         * Stdin data to send to the executing process.
         * Can be sent multiple times after init.
         *
         * @generated from protobuf field: coreweave.sandbox.v1beta2.ExecStreamData stdin = 2
         */
        stdin: ExecStreamData;
    } | {
        oneofKind: "resize";
        /**
         * Terminal resize event for TTY sessions.
         * Can be sent multiple times after init.
         *
         * @generated from protobuf field: coreweave.sandbox.v1beta2.ExecStreamResize resize = 3
         */
        resize: ExecStreamResize;
    } | {
        oneofKind: "close";
        /**
         * Signal to close the stdin stream.
         * Process will continue running, but will receive EOF on stdin.
         *
         * @generated from protobuf field: coreweave.sandbox.v1beta2.ExecStreamClose close = 4
         */
        close: ExecStreamClose;
    } | {
        oneofKind: undefined;
    };
}
/**
 * ExecStreamInit initiates a streaming exec session.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.ExecStreamInit
 */
export interface ExecStreamInit {
    /**
     * The sandbox ID where the command should be executed.
     *
     * @generated from protobuf field: string sandbox_id = 1
     */
    sandboxId: string;
    /**
     * Command and arguments to execute.
     * The first element is the command, subsequent elements are arguments.
     *
     * @generated from protobuf field: repeated string command = 2
     */
    command: string[];
    /**
     * Enable TTY (pseudo-terminal) mode.
     * When enabled, stdout and stderr are combined into a single stream.
     *
     * @generated from protobuf field: bool tty = 3
     */
    tty: boolean;
    /**
     * Initial terminal width in columns (for TTY mode).
     *
     * @generated from protobuf field: uint32 tty_width = 4
     */
    ttyWidth: number;
    /**
     * Initial terminal height in rows (for TTY mode).
     *
     * @generated from protobuf field: uint32 tty_height = 5
     */
    ttyHeight: number;
    /**
     * Environment variables to set for the command execution.
     *
     * @generated from protobuf field: map<string, string> env = 6
     */
    env: {
        [key: string]: string;
    };
    /**
     * Resume an existing exec session that was interrupted (e.g. the client lost
     * its connection during a Gateway roll). A non-empty value switches the
     * request into "resume mode": the server reattaches the caller to the
     * live session on the owning Runner and IGNORES command/tty/tty_width/
     * tty_height/env. Sandbox_id is still validated for authorization.
     *
     * The server MUST reject a request that combines resume_session_id with
     * non-empty command, non-default tty/tty_width/tty_height, or non-empty
     * env with INVALID_ARGUMENT — these field combinations are protocol
     * errors, not silent overrides. (The reject keeps "init mode" and
     * "resume mode" semantically exclusive so a future tightening of the
     * contract doesn't break existing SDKs that rely on silent ignore.)
     *
     * Applies to all exec sessions (TTY and non-TTY). The session_id was
     * returned in StreamingExecReady.session_id on the original stream. If
     * the session is no longer present (lost, expired, or torn down) the
     * server returns ExecStreamError{code: "SESSION_NOT_FOUND"} and the
     * client should fall back to a fresh init.
     *
     * @generated from protobuf field: string resume_session_id = 7
     */
    resumeSessionId: string;
}
/**
 * ExecStreamData carries stdin data to send to the executing process.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.ExecStreamData
 */
export interface ExecStreamData {
    /**
     * Raw stdin bytes to send to the process.
     *
     * @generated from protobuf field: bytes data = 1
     */
    data: Uint8Array;
}
/**
 * ExecStreamResize signals a terminal resize event for TTY sessions.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.ExecStreamResize
 */
export interface ExecStreamResize {
    /**
     * New terminal width in columns.
     *
     * @generated from protobuf field: uint32 width = 1
     */
    width: number;
    /**
     * New terminal height in rows.
     *
     * @generated from protobuf field: uint32 height = 2
     */
    height: number;
}
/**
 * ExecStreamClose signals that the client is closing stdin.
 * The process will receive EOF on stdin but will continue executing.
 * The stream will continue to deliver stdout/stderr until the process exits.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.ExecStreamClose
 */
export interface ExecStreamClose {
}
/**
 * StreamingExecReady signals that stdin is ready to receive data.
 * Sent after SPDY connection is established and the exec session is ready.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.StreamingExecReady
 */
export interface StreamingExecReady {
    /**
     * Timestamp when the exec session became ready for input.
     *
     * @generated from protobuf field: google.protobuf.Timestamp ready_at = 1
     */
    readyAt?: Timestamp;
    /**
     * Server-issued opaque session identifier. Sent exactly once per
     * underlying Runner session: on a fresh init it accompanies the first
     * StreamingExecReady; on a successful resume the server does NOT
     * re-send a Ready frame (the existing session is already running), so
     * the client should retain the session_id it received on the original
     * stream. The client SHOULD persist this for the lifetime of the
     * stream and pass it as ExecStreamInit.resume_session_id on a
     * subsequent stream if the original is interrupted, to reattach to
     * the live session instead of re-executing the command.
     *
     * @generated from protobuf field: string session_id = 2
     */
    sessionId: string;
}
/**
 * ExecStreamResponse is sent by server with stdout/stderr/status updates.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.ExecStreamResponse
 */
export interface ExecStreamResponse {
    /**
     * @generated from protobuf oneof: response
     */
    response: {
        oneofKind: "output";
        /**
         * A chunk of stdout or stderr output from the process.
         *
         * @generated from protobuf field: coreweave.sandbox.v1beta2.ExecStreamOutput output = 1
         */
        output: ExecStreamOutput;
    } | {
        oneofKind: "exit";
        /**
         * Process exit notification with exit code.
         * This is the final message for a successful execution.
         *
         * @generated from protobuf field: coreweave.sandbox.v1beta2.ExecStreamExit exit = 2
         */
        exit: ExecStreamExit;
    } | {
        oneofKind: "error";
        /**
         * Error during execution.
         * This is the final message for a failed execution.
         *
         * @generated from protobuf field: coreweave.sandbox.v1beta2.ExecStreamError error = 3
         */
        error: ExecStreamError;
    } | {
        oneofKind: "ready";
        /**
         * Signal that the exec session is ready for stdin input.
         * Sent after SPDY connection is established.
         *
         * @generated from protobuf field: coreweave.sandbox.v1beta2.StreamingExecReady ready = 4
         */
        ready: StreamingExecReady;
    } | {
        oneofKind: undefined;
    };
}
/**
 * ExecStreamOutput carries a chunk of stdout or stderr data.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.ExecStreamOutput
 */
export interface ExecStreamOutput {
    /**
     * The type of this output (stdout or stderr).
     * In TTY mode, all output is sent as STDOUT.
     *
     * @generated from protobuf field: coreweave.sandbox.v1beta2.ExecStreamOutput.StreamType stream_type = 1
     */
    streamType: ExecStreamOutput_StreamType;
    /**
     * Raw output bytes.
     *
     * @generated from protobuf field: bytes data = 2
     */
    data: Uint8Array;
    /**
     * Timestamp when this output was captured.
     *
     * @generated from protobuf field: google.protobuf.Timestamp timestamp = 3
     */
    timestamp?: Timestamp;
}
/**
 * The type of output stream.
 *
 * @generated from protobuf enum coreweave.sandbox.v1beta2.ExecStreamOutput.StreamType
 */
export declare enum ExecStreamOutput_StreamType {
    /**
     * Unspecified stream type (should not be used).
     *
     * @generated from protobuf enum value: STREAM_TYPE_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * Standard output stream.
     *
     * @generated from protobuf enum value: STREAM_TYPE_STDOUT = 1;
     */
    STDOUT = 1,
    /**
     * Standard error stream.
     *
     * @generated from protobuf enum value: STREAM_TYPE_STDERR = 2;
     */
    STDERR = 2
}
/**
 * ExecStreamExit signals that the process has completed execution.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.ExecStreamExit
 */
export interface ExecStreamExit {
    /**
     * The exit code of the process.
     * 0 indicates success, non-zero indicates an error.
     *
     * @generated from protobuf field: int32 exit_code = 1
     */
    exitCode: number;
    /**
     * Timestamp when the process completed.
     *
     * @generated from protobuf field: google.protobuf.Timestamp completed_at = 2
     */
    completedAt?: Timestamp;
}
/**
 * ExecStreamError indicates an error during execution. Every value of
 * ExecStreamError is terminal: it is the final message on the stream
 * and the client MUST NOT attempt to consume additional frames after
 * receiving it. The `code` field tells the client what shape its next
 * init (if any) should take.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.ExecStreamError
 */
export interface ExecStreamError {
    /**
     * Human-readable error message.
     *
     * @generated from protobuf field: string message = 1
     */
    message: string;
    /**
     * Error code for programmatic error handling. Each documented code
     * ends with the prescribed client retry shape (no retry / fresh init
     * / resume init).
     * Examples:
     *   "SANDBOX_NOT_FOUND"     — terminal; no retry.
     *   "EXEC_FAILED"           — terminal; no retry (the command itself failed).
     *   "PERMISSION_DENIED"     — terminal; no retry.
     *   "RUNNER_UNAVAILABLE"    — transient; retry with FRESH init (no resume,
     *                             exec state did not survive).
     *   "RUNNER_DRAINING"       — transient; retry with FRESH init (exec state
     *                             cannot cross a Runner roll).
     *   "SESSION_NOT_FOUND"     — resume_session_id is unknown or expired;
     *                             retry with FRESH init.
     *   "STREAM_BACKPRESSURE"   — terminal; the stream was torn down because the
     *                             consumer could not keep up and output may be
     *                             incomplete. NOT auto-retriable / not resumable:
     *                             safe to retry only if the caller accepts
     *                             re-running the command (it may have side
     *                             effects). Distinct from RUNNER_UNAVAILABLE,
     *                             which implies infra outage.
     *
     * @generated from protobuf field: string code = 2
     */
    code: string;
}
/**
 * LogStreamRequest is sent by client to initiate or control log streaming.
 * The first message must be an init message, optionally followed by a close message.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.LogStreamRequest
 */
export interface LogStreamRequest {
    /**
     * @generated from protobuf oneof: request
     */
    request: {
        oneofKind: "init";
        /**
         * Initial request to start log streaming.
         * Must be the first message sent on the stream.
         *
         * @generated from protobuf field: coreweave.sandbox.v1beta2.LogStreamInit init = 1
         */
        init: LogStreamInit;
    } | {
        oneofKind: "close";
        /**
         * Signal to close the log stream.
         * In follow mode, this stops tailing new logs.
         *
         * @generated from protobuf field: coreweave.sandbox.v1beta2.LogStreamClose close = 2
         */
        close: LogStreamClose;
    } | {
        oneofKind: undefined;
    };
}
/**
 * LogStreamInit initiates a log streaming session.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.LogStreamInit
 */
export interface LogStreamInit {
    /**
     * The sandbox ID whose logs should be streamed.
     *
     * @generated from protobuf field: string sandbox_id = 1
     */
    sandboxId: string;
    /**
     * Follow mode - continue streaming new logs as they are generated (like tail -f).
     * If false, returns existing logs and closes the stream.
     *
     * @generated from protobuf field: bool follow = 2
     */
    follow: boolean;
    /**
     * Number of lines to retrieve from the end of the logs.
     * If not specified and follow is false, retrieves all available logs.
     *
     * @generated from protobuf field: int32 tail_lines = 3
     */
    tailLines: number;
    /**
     * Only return logs after this timestamp.
     *
     * @generated from protobuf field: google.protobuf.Timestamp since_time = 4
     */
    sinceTime?: Timestamp;
    /**
     * Include timestamps in the log output.
     *
     * @generated from protobuf field: bool timestamps = 5
     */
    timestamps: boolean;
    /**
     * Resume an existing FOLLOW-MODE log session. A non-empty value switches
     * the request into "resume mode": the server reattaches to the live
     * session on the owning Runner and replays from resume_offset onward
     * (bounded by the per-session replay window). When set, all other
     * fields except sandbox_id are ignored.
     *
     * The server MUST reject a request that combines resume_session_id
     * with follow=false (the underlying session only exists for follow
     * mode) or with non-default tail_lines / since_time / timestamps with
     * INVALID_ARGUMENT.
     *
     * If the session is no longer present (lost, expired, or torn down)
     * the server returns LogStreamError{code: "SESSION_NOT_FOUND"} and
     * the client should fall back to a fresh init.
     *
     * @generated from protobuf field: string resume_session_id = 6
     */
    resumeSessionId: string;
    /**
     * Cumulative byte offset the client has successfully received and
     * processed. On resume, the server replays starting from this offset.
     * Bytes that were in flight at disconnect (sent by the server but not
     * received by the client) are NOT included in resume_offset and will
     * be replayed — this gives at-least-once delivery without an explicit
     * ack channel.
     *
     * Monotonicity is recommended but not required by the server: a
     * duplicate or lower resume_offset just replays more bytes than
     * strictly necessary. The client is the authoritative source for what
     * it has delivered; the server does not track per-client state.
     *
     * If resume_offset is below the oldest byte still held in the server's
     * replay window, the server emits LogStreamError{code: "REPLAY_GAP"}
     * (terminal — see LogStreamError docs). Ignored when resume_session_id
     * is empty.
     *
     * @generated from protobuf field: uint64 resume_offset = 7
     */
    resumeOffset: string;
}
/**
 * LogStreamClose signals that the client is closing the log stream.
 * In follow mode, this stops tailing new logs.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.LogStreamClose
 */
export interface LogStreamClose {
}
/**
 * LogStreamResponse is sent by server with log data or status updates.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.LogStreamResponse
 */
export interface LogStreamResponse {
    /**
     * @generated from protobuf oneof: response
     */
    response: {
        oneofKind: "data";
        /**
         * Log data chunk.
         *
         * @generated from protobuf field: coreweave.sandbox.v1beta2.LogStreamData data = 1
         */
        data: LogStreamData;
    } | {
        oneofKind: "error";
        /**
         * Error during log streaming.
         * This is the final message for a failed stream.
         *
         * @generated from protobuf field: coreweave.sandbox.v1beta2.LogStreamError error = 2
         */
        error: LogStreamError;
    } | {
        oneofKind: "complete";
        /**
         * Stream completed indicator (for non-follow mode).
         * This is the final message for a successful non-follow stream.
         *
         * @generated from protobuf field: coreweave.sandbox.v1beta2.LogStreamComplete complete = 3
         */
        complete: LogStreamComplete;
    } | {
        oneofKind: undefined;
    };
}
/**
 * LogStreamData carries a chunk of log data.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.LogStreamData
 */
export interface LogStreamData {
    /**
     * Raw log bytes.
     *
     * @generated from protobuf field: bytes data = 1
     */
    data: Uint8Array;
    /**
     * Timestamp when this log data was generated.
     * Only present if timestamps were requested in LogStreamInit.
     *
     * @generated from protobuf field: google.protobuf.Timestamp timestamp = 2
     */
    timestamp?: Timestamp;
    /**
     * Server-issued opaque session identifier. Stable for the lifetime of the
     * underlying Runner session and present on every LogStreamData message
     * (including resumes). The client SHOULD persist this and pass it as
     * LogStreamInit.resume_session_id on a subsequent stream if the original
     * is interrupted, to reattach without losing the live tail.
     *
     * @generated from protobuf field: string session_id = 3
     */
    sessionId: string;
    /**
     * Cumulative byte offset *after* this chunk — i.e., for a 100-byte
     * chunk starting at offset 500, this field is 600. The client should
     * persist the highest value it has successfully received and echo it
     * as LogStreamInit.resume_offset on the next init if the stream is
     * interrupted.
     *
     * The server does not track per-client delivery state; the client's
     * echoed offset is the authoritative ack for resume purposes. The
     * server retains a bounded replay window after the chunk is sent (see
     * LogStreamInit.resume_offset for REPLAY_GAP semantics).
     *
     * @generated from protobuf field: uint64 offset = 4
     */
    offset: string;
}
/**
 * LogStreamComplete indicates that the log stream has ended.
 * This is only sent in non-follow mode after all logs have been delivered.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.LogStreamComplete
 */
export interface LogStreamComplete {
}
/**
 * LogStreamError indicates an error during log streaming. Every value of
 * LogStreamError is terminal: it is the final message on the stream and
 * the client MUST NOT attempt to consume additional frames after
 * receiving it. The `code` field tells the client what shape its next
 * init (if any) should take.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.LogStreamError
 */
export interface LogStreamError {
    /**
     * Human-readable error message.
     *
     * @generated from protobuf field: string message = 1
     */
    message: string;
    /**
     * Error code for programmatic error handling. Each documented code
     * ends with the prescribed client retry shape (no retry / fresh init
     * / resume init from head).
     * Examples:
     *   "SANDBOX_NOT_FOUND"        — terminal; no retry.
     *   "PERMISSION_DENIED"        — terminal; no retry.
     *   "RUNNER_UNAVAILABLE"       — transient; retry with FRESH init
     *                                (resume not possible — logs moved).
     *   "RUNNER_DRAINING"          — transient; retry with FRESH init
     *                                (resume not possible — logs moved).
     *   "SESSION_NOT_FOUND"        — resume_session_id is unknown or
     *                                expired; retry with FRESH init.
     *   "REPLAY_GAP"               — resume_offset was below the oldest
     *                                byte still in the server's replay
     *                                window; some bytes were permanently
     *                                missed. Terminal; client may
     *                                immediately reconnect with FRESH init
     *                                (no resume_offset) to resume the live
     *                                tail from the current head.
     *   "INVALID_RESUME_OFFSET"    — resume_offset is ahead of any byte the
     *                                server has emitted; terminal, no retry
     *                                (the echoed offset is corrupt).
     *
     * @generated from protobuf field: string code = 2
     */
    code: string;
}
declare class ExecStreamRequest$Type extends MessageType<ExecStreamRequest> {
    constructor();
    create(value?: PartialMessage<ExecStreamRequest>): ExecStreamRequest;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: ExecStreamRequest): ExecStreamRequest;
    internalBinaryWrite(message: ExecStreamRequest, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.ExecStreamRequest
 */
export declare const ExecStreamRequest: ExecStreamRequest$Type;
declare class ExecStreamInit$Type extends MessageType<ExecStreamInit> {
    constructor();
    create(value?: PartialMessage<ExecStreamInit>): ExecStreamInit;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: ExecStreamInit): ExecStreamInit;
    private binaryReadMap6;
    internalBinaryWrite(message: ExecStreamInit, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.ExecStreamInit
 */
export declare const ExecStreamInit: ExecStreamInit$Type;
declare class ExecStreamData$Type extends MessageType<ExecStreamData> {
    constructor();
    create(value?: PartialMessage<ExecStreamData>): ExecStreamData;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: ExecStreamData): ExecStreamData;
    internalBinaryWrite(message: ExecStreamData, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.ExecStreamData
 */
export declare const ExecStreamData: ExecStreamData$Type;
declare class ExecStreamResize$Type extends MessageType<ExecStreamResize> {
    constructor();
    create(value?: PartialMessage<ExecStreamResize>): ExecStreamResize;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: ExecStreamResize): ExecStreamResize;
    internalBinaryWrite(message: ExecStreamResize, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.ExecStreamResize
 */
export declare const ExecStreamResize: ExecStreamResize$Type;
declare class ExecStreamClose$Type extends MessageType<ExecStreamClose> {
    constructor();
    create(value?: PartialMessage<ExecStreamClose>): ExecStreamClose;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: ExecStreamClose): ExecStreamClose;
    internalBinaryWrite(message: ExecStreamClose, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.ExecStreamClose
 */
export declare const ExecStreamClose: ExecStreamClose$Type;
declare class StreamingExecReady$Type extends MessageType<StreamingExecReady> {
    constructor();
    create(value?: PartialMessage<StreamingExecReady>): StreamingExecReady;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: StreamingExecReady): StreamingExecReady;
    internalBinaryWrite(message: StreamingExecReady, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.StreamingExecReady
 */
export declare const StreamingExecReady: StreamingExecReady$Type;
declare class ExecStreamResponse$Type extends MessageType<ExecStreamResponse> {
    constructor();
    create(value?: PartialMessage<ExecStreamResponse>): ExecStreamResponse;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: ExecStreamResponse): ExecStreamResponse;
    internalBinaryWrite(message: ExecStreamResponse, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.ExecStreamResponse
 */
export declare const ExecStreamResponse: ExecStreamResponse$Type;
declare class ExecStreamOutput$Type extends MessageType<ExecStreamOutput> {
    constructor();
    create(value?: PartialMessage<ExecStreamOutput>): ExecStreamOutput;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: ExecStreamOutput): ExecStreamOutput;
    internalBinaryWrite(message: ExecStreamOutput, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.ExecStreamOutput
 */
export declare const ExecStreamOutput: ExecStreamOutput$Type;
declare class ExecStreamExit$Type extends MessageType<ExecStreamExit> {
    constructor();
    create(value?: PartialMessage<ExecStreamExit>): ExecStreamExit;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: ExecStreamExit): ExecStreamExit;
    internalBinaryWrite(message: ExecStreamExit, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.ExecStreamExit
 */
export declare const ExecStreamExit: ExecStreamExit$Type;
declare class ExecStreamError$Type extends MessageType<ExecStreamError> {
    constructor();
    create(value?: PartialMessage<ExecStreamError>): ExecStreamError;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: ExecStreamError): ExecStreamError;
    internalBinaryWrite(message: ExecStreamError, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.ExecStreamError
 */
export declare const ExecStreamError: ExecStreamError$Type;
declare class LogStreamRequest$Type extends MessageType<LogStreamRequest> {
    constructor();
    create(value?: PartialMessage<LogStreamRequest>): LogStreamRequest;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: LogStreamRequest): LogStreamRequest;
    internalBinaryWrite(message: LogStreamRequest, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.LogStreamRequest
 */
export declare const LogStreamRequest: LogStreamRequest$Type;
declare class LogStreamInit$Type extends MessageType<LogStreamInit> {
    constructor();
    create(value?: PartialMessage<LogStreamInit>): LogStreamInit;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: LogStreamInit): LogStreamInit;
    internalBinaryWrite(message: LogStreamInit, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.LogStreamInit
 */
export declare const LogStreamInit: LogStreamInit$Type;
declare class LogStreamClose$Type extends MessageType<LogStreamClose> {
    constructor();
    create(value?: PartialMessage<LogStreamClose>): LogStreamClose;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: LogStreamClose): LogStreamClose;
    internalBinaryWrite(message: LogStreamClose, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.LogStreamClose
 */
export declare const LogStreamClose: LogStreamClose$Type;
declare class LogStreamResponse$Type extends MessageType<LogStreamResponse> {
    constructor();
    create(value?: PartialMessage<LogStreamResponse>): LogStreamResponse;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: LogStreamResponse): LogStreamResponse;
    internalBinaryWrite(message: LogStreamResponse, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.LogStreamResponse
 */
export declare const LogStreamResponse: LogStreamResponse$Type;
declare class LogStreamData$Type extends MessageType<LogStreamData> {
    constructor();
    create(value?: PartialMessage<LogStreamData>): LogStreamData;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: LogStreamData): LogStreamData;
    internalBinaryWrite(message: LogStreamData, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.LogStreamData
 */
export declare const LogStreamData: LogStreamData$Type;
declare class LogStreamComplete$Type extends MessageType<LogStreamComplete> {
    constructor();
    create(value?: PartialMessage<LogStreamComplete>): LogStreamComplete;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: LogStreamComplete): LogStreamComplete;
    internalBinaryWrite(message: LogStreamComplete, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.LogStreamComplete
 */
export declare const LogStreamComplete: LogStreamComplete$Type;
declare class LogStreamError$Type extends MessageType<LogStreamError> {
    constructor();
    create(value?: PartialMessage<LogStreamError>): LogStreamError;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: LogStreamError): LogStreamError;
    internalBinaryWrite(message: LogStreamError, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.LogStreamError
 */
export declare const LogStreamError: LogStreamError$Type;
/**
 * @generated ServiceType for protobuf service coreweave.sandbox.v1beta2.GatewayStreamingService
 */
export declare const GatewayStreamingService: ServiceType;

//# sourceMappingURL=streaming.d.ts.map