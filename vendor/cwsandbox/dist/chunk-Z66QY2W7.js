// src/errors.ts
var CWSandboxError = class extends Error {
  code;
  constructor(message, code, options) {
    super(message, options);
    this.code = code;
    this.name = "CWSandboxError";
  }
};
function isCWSandboxError(error) {
  return error instanceof CWSandboxError;
}
var CWSandboxConfigurationError = class extends CWSandboxError {
  constructor(message, options) {
    super(message, "configuration_error", options);
    this.name = "CWSandboxConfigurationError";
  }
};
var CWSandboxNotImplementedError = class extends CWSandboxError {
  constructor(message, options) {
    super(message, "not_implemented", options);
    this.name = "CWSandboxNotImplementedError";
  }
};
var CWSandboxTransportError = class extends CWSandboxError {
  metadata;
  operation;
  sandboxId;
  transport;
  transportCode;
  constructor(message, options = {}, code = "transport_error") {
    super(message, code, options);
    this.name = "CWSandboxTransportError";
    this.metadata = options.metadata;
    this.operation = options.operation;
    this.sandboxId = options.sandboxId;
    this.transport = options.transport;
    this.transportCode = options.transportCode;
  }
};
var CWSandboxAuthenticationError = class extends CWSandboxTransportError {
  constructor(message, options) {
    super(message, options, "authentication_error");
    this.name = "CWSandboxAuthenticationError";
  }
};
var CWSandboxNotFoundError = class extends CWSandboxTransportError {
  constructor(message, options) {
    super(message, options, "not_found");
    this.name = "CWSandboxNotFoundError";
  }
};
var CWSandboxTimeoutError = class extends CWSandboxTransportError {
  constructor(message, options) {
    super(message, options, "timeout_error");
    this.name = "CWSandboxTimeoutError";
  }
};
var CWSandboxUnavailableError = class extends CWSandboxTransportError {
  constructor(message, options) {
    super(message, options, "unavailable");
    this.name = "CWSandboxUnavailableError";
  }
};
var CWSandboxResourceExhaustedError = class extends CWSandboxTransportError {
  constructor(message, options) {
    super(message, options, "resource_exhausted");
    this.name = "CWSandboxResourceExhaustedError";
  }
};
var CWSandboxValidationError = class extends CWSandboxError {
  constructor(message, options) {
    super(message, "validation_error", options);
    this.name = "CWSandboxValidationError";
  }
};

// src/defaults.ts
var DEFAULT_KEEP_ALIVE_COMMAND = [
  "/bin/sh",
  "-lc",
  "trap 'exit 0' TERM INT; sleep infinity & wait"
];

// src/commands.ts
function commandForWorkingDirectory(command, cwd) {
  if (cwd === void 0) {
    return [...command];
  }
  return ["/bin/sh", "-lc", `cd ${shellQuote(cwd)} && exec ${command.map(shellQuote).join(" ")}`];
}
function normalizeCommand(command) {
  const [executable, ...args] = command;
  if (executable === void 0) {
    throw new CWSandboxValidationError("Command must contain at least one item.");
  }
  if (executable.trim() === "") {
    throw new CWSandboxValidationError("Command executable must not be blank.");
  }
  return [executable, ...args];
}
function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// src/mounted-files.ts
var textEncoder = new TextEncoder();
function normalizeMountedFiles(mountedFiles) {
  if (mountedFiles === void 0) {
    return [];
  }
  if (Array.isArray(mountedFiles)) {
    return mountedFiles;
  }
  return Object.entries(mountedFiles).map(([path, content]) => ({
    content,
    path
  }));
}
function normalizeFileContent(content) {
  return typeof content === "string" ? textEncoder.encode(content) : content;
}
function normalizeFileWrites(files) {
  if (Array.isArray(files)) {
    return files;
  }
  return Object.entries(files).map(([path, content]) => ({
    content,
    path
  }));
}
function validateFileWrites(files) {
  validateUniqueAbsolutePaths(
    normalizeFileWrites(files).map((file) => file.path),
    "files.write path"
  );
}
function validateReadPaths(paths) {
  validateUniqueAbsolutePaths(paths, "files.read path");
}
function validateMountedFiles(mountedFiles) {
  validateUniqueAbsolutePaths(
    normalizeMountedFiles(mountedFiles).map((file) => file.path),
    "mountedFiles path"
  );
}
function validateUniqueAbsolutePaths(paths, fieldName) {
  const seen = /* @__PURE__ */ new Set();
  for (const path of paths) {
    validateAbsolutePath(path, fieldName);
    if (seen.has(path)) {
      throw new CWSandboxValidationError(`${fieldName} contains duplicate path: ${path}`);
    }
    seen.add(path);
  }
}
function validateAbsolutePath(path, fieldName) {
  if (path === "") {
    throw new CWSandboxValidationError(`${fieldName} must not be empty`);
  }
  if (!path.startsWith("/")) {
    throw new CWSandboxValidationError(`${fieldName} must be absolute`);
  }
}

// src/network.ts
function normalizePorts(ports) {
  return ports?.map((port) => typeof port === "number" ? { port } : port) ?? [];
}
function validateNetworkOptions(ports, network) {
  const normalizedPorts = normalizePorts(ports);
  validatePorts(normalizedPorts);
  validateNetwork(network, normalizedPorts);
}
function validatePorts(ports) {
  const seenPorts = /* @__PURE__ */ new Set();
  for (const { port, name, protocol } of ports) {
    validatePortNumber(port, "ports.port");
    if (seenPorts.has(port)) {
      throw new CWSandboxValidationError(`ports contains duplicate port: ${port}`);
    }
    if (name !== void 0 && name.trim() === "") {
      throw new CWSandboxValidationError("ports.name must not be empty");
    }
    if (protocol !== void 0 && protocol.trim() === "") {
      throw new CWSandboxValidationError("ports.protocol must not be empty");
    }
    seenPorts.add(port);
  }
}
function validateNetwork(network, ports) {
  if (network === void 0) {
    return;
  }
  if (network.ingressMode !== void 0 && network.ingressMode.trim() === "") {
    throw new CWSandboxValidationError("network.ingressMode must not be empty");
  }
  if (network.egressMode !== void 0 && network.egressMode.trim() === "") {
    throw new CWSandboxValidationError("network.egressMode must not be empty");
  }
  const declaredPorts = new Set(ports.map((port) => port.port));
  for (const exposedPort of network.exposedPorts ?? []) {
    validatePortNumber(exposedPort, "network.exposedPorts");
    if (declaredPorts.size > 0 && !declaredPorts.has(exposedPort)) {
      throw new CWSandboxValidationError(
        `network.exposedPorts contains undeclared port: ${exposedPort}`
      );
    }
  }
}
function validatePortNumber(port, fieldName) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CWSandboxValidationError(`${fieldName} must be an integer between 1 and 65535`);
  }
}

// src/resources.ts
var RESOURCE_KEYS = ["cpu", "memory"];
function validateResources(resources) {
  if (resources === void 0) {
    return;
  }
  if (isAdvancedResources(resources)) {
    if ("cpu" in resources || "memory" in resources) {
      throw new CWSandboxValidationError("resources cannot mix cpu/memory with requests/limits");
    }
    if (!("requests" in resources) || !("limits" in resources)) {
      throw new CWSandboxValidationError("resources must include both requests and limits");
    }
    validateResourceSpec(resources.requests, "resources.requests");
    validateResourceSpec(resources.limits, "resources.limits");
    return;
  }
  validateResourceSpec(resources, "resources");
}
function isAdvancedResources(resources) {
  return "requests" in resources || "limits" in resources;
}
function validateResourceSpec(spec, fieldName) {
  if (Object.keys(spec).length === 0) {
    throw new CWSandboxValidationError(`${fieldName} must not be empty`);
  }
  for (const key of RESOURCE_KEYS) {
    const value = spec[key];
    if (value === void 0) {
      continue;
    }
    if (value === "") {
      throw new CWSandboxValidationError(`${fieldName}.${key} must not be empty`);
    }
  }
}

// src/validation/annotations.ts
function validateAnnotations(annotations) {
  if (annotations === void 0) {
    return;
  }
  if (annotations === null || typeof annotations !== "object" || Array.isArray(annotations)) {
    throw new CWSandboxValidationError("annotations must be an object of string values");
  }
  const entries = Object.entries(annotations);
  if (entries.length > 100) {
    throw new CWSandboxValidationError("annotations must contain 100 entries or fewer");
  }
  for (const [key, value] of entries) {
    if (key === "") {
      throw new CWSandboxValidationError("annotations must not contain empty keys");
    }
    if (typeof value !== "string") {
      throw new CWSandboxValidationError(`annotations["${key}"] must be a string`);
    }
    if (value === "") {
      throw new CWSandboxValidationError(`annotations["${key}"] must not be empty`);
    }
  }
}

// src/validation/string-list.ts
function validateUniqueStringList(values, name) {
  if (values === void 0) {
    return;
  }
  if (!Array.isArray(values)) {
    throw new CWSandboxValidationError(`${name} must be an array of strings`);
  }
  const seen = /* @__PURE__ */ new Set();
  for (const value of values) {
    if (typeof value !== "string") {
      throw new CWSandboxValidationError(`${name} must contain only strings`);
    }
    if (value === "") {
      throw new CWSandboxValidationError(`${name} must not contain empty values`);
    }
    if (seen.has(value)) {
      throw new CWSandboxValidationError(`${name} contains duplicate value: ${value}`);
    }
    seen.add(value);
  }
}

// src/validation/tags.ts
var SANDBOX_TAG_PATTERN = /^[A-Za-z0-9._-]*[A-Za-z0-9]$/;
var SANDBOX_TAG_RULE = "tags may contain letters, numbers, '.', '_' or '-', must be 59 characters or fewer, must end with a letter or number, and may start with '.', '_' or '-'";
function validateTags(tags) {
  validateUniqueStringList(tags, "tags");
  if (tags === void 0) {
    return;
  }
  for (const tag of tags) {
    if (tag.length > 59 || !SANDBOX_TAG_PATTERN.test(tag)) {
      throw new CWSandboxValidationError(
        `tags contains invalid value: ${tag}. ${SANDBOX_TAG_RULE}`
      );
    }
  }
}

// src/validation.ts
function validateRequestOptions(options) {
  validateNonNegativeFinite(options.timeoutMs, "timeoutMs");
}
function validateExecOptions(options) {
  validateCommandOptions(options);
}
function validateStartCommandOptions(options) {
  validateCommandOptions(options);
}
function validateCommandOptions(options) {
  validateRequestOptions(options);
  validateNonNegativeInteger(options.bufferedMaxKiB, "bufferedMaxKiB");
  validateOptionalNonBlankString(options.cwd, "cwd");
  if ("stdin" in options) {
    validateOptionalBoolean(options.stdin, "stdin");
  }
}
function validateSandboxRunOptions(options) {
  validateRequestOptions(options);
  validateAnnotations(options.annotations);
  validateNonNegativeFinite(options.maxLifetimeSeconds, "maxLifetimeSeconds");
  validateMountedFiles(options.mountedFiles);
  validateNetworkOptions(options.ports, options.network);
  validateResources(options.resources);
  validateUniqueStringList(options.profileIds, "profileIds");
  validateUniqueStringList(options.profileNames, "profileNames");
  validateUniqueStringList(options.runnerIds, "runnerIds");
  validateTags(options.tags);
  validateOptionalBoolean(options.waitUntilRunning, "waitUntilRunning");
}
function validateWaitOptions(options) {
  validateRequestOptions(options);
  validateNonNegativeFinite(options.intervalMs, "intervalMs");
}
function validateStopOptions(options) {
  validateRequestOptions(options);
  validateNonNegativeInteger(options.gracefulShutdownSeconds, "gracefulShutdownSeconds");
}
function validateListSandboxesOptions(options) {
  validateRequestOptions(options);
  validateNonNegativeInteger(options.pageSize, "pageSize");
  validateTags(options.tags);
}
function validateLogReadOptions(options) {
  validateLogStreamOptions(options);
  if (options.follow === true) {
    throw new CWSandboxValidationError("logs.read does not support follow: true.");
  }
}
function validateLogStreamOptions(options) {
  validateRequestOptions(options);
  validateNonNegativeInteger(options.tailLines, "tailLines");
  validateOptionalBoolean(options.follow, "follow");
  validateOptionalBoolean(options.timestamps, "timestamps");
  validateSinceTime(options.sinceTime);
  validateLogResume(options);
}
function validateNonNegativeFinite(value, name) {
  if (value === void 0) {
    return;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new CWSandboxValidationError(`${name} must be a finite non-negative number.`);
  }
}
function validateNonNegativeInteger(value, name) {
  validateNonNegativeFinite(value, name);
  if (value !== void 0 && !Number.isInteger(value)) {
    throw new CWSandboxValidationError(`${name} must be an integer.`);
  }
}
function validateOptionalNonBlankString(value, name) {
  if (value === void 0) {
    return;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new CWSandboxValidationError(`${name} must not be empty.`);
  }
}
function validateOptionalBoolean(value, name) {
  if (value !== void 0 && typeof value !== "boolean") {
    throw new CWSandboxValidationError(`${name} must be a boolean.`);
  }
}
function validateSinceTime(value) {
  if (value === void 0) {
    return;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new CWSandboxValidationError("sinceTime must be a valid Date.");
    }
    return;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new CWSandboxValidationError("sinceTime must be a Date or timestamp string.");
  }
  if (Number.isNaN(new Date(value).getTime())) {
    throw new CWSandboxValidationError("sinceTime must be a valid timestamp string.");
  }
}
function validateLogResume(options) {
  const resume = options.resume;
  if (resume === void 0) {
    return;
  }
  if (options.follow !== true) {
    throw new CWSandboxValidationError("resume requires follow: true.");
  }
  validateOptionalNonBlankString(resume.sessionId, "resume.sessionId");
  validateResumeOffset(resume.offset);
  if (options.tailLines !== void 0 || options.sinceTime !== void 0 || options.timestamps === true) {
    throw new CWSandboxValidationError(
      "resume cannot be combined with tailLines, sinceTime, or timestamps."
    );
  }
}
function validateResumeOffset(value) {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new CWSandboxValidationError("resume.offset must be non-negative.");
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new CWSandboxValidationError("resume.offset must be a safe non-negative integer.");
    }
    return;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new CWSandboxValidationError("resume.offset must be a non-negative integer.");
  }
}

// src/sandbox/commands.ts
function createSandboxCommands(runtime) {
  const start = startCommand.bind(void 0, runtime);
  return {
    run: (command, execOptions) => execCommand(runtime, command, execOptions),
    start
  };
}
async function execCommand(runtime, command, options = {}) {
  validateExecOptions(options);
  return runtime.transport.exec({
    ...options,
    command: normalizeCommand(command),
    sandboxId: runtime.sandboxId
  });
}
async function startCommand(runtime, command, options = {}) {
  validateStartCommandOptions(options);
  return runtime.transport.startCommand({
    ...options,
    command: normalizeCommand(command),
    sandboxId: runtime.sandboxId
  });
}

// src/sandbox/files.ts
var textDecoder = new TextDecoder();
function createSandboxFiles(runtime) {
  return {
    read: readFile.bind(void 0, runtime),
    readText: readTextFile.bind(void 0, runtime),
    write: writeFile.bind(void 0, runtime)
  };
}
async function readFile(runtime, pathOrPaths, options = {}) {
  validateRequestOptions(options);
  if (typeof pathOrPaths !== "string") {
    validateReadPaths(pathOrPaths);
    return readEntries(
      await Promise.all(
        pathOrPaths.map(async (path) => [path, await readSingleFile(runtime, path, options)])
      )
    );
  }
  return readSingleFile(runtime, pathOrPaths, options);
}
async function readTextFile(runtime, pathOrPaths, options = {}) {
  validateRequestOptions(options);
  if (typeof pathOrPaths === "string") {
    return textDecoder.decode(await readSingleFile(runtime, pathOrPaths, options));
  }
  validateReadPaths(pathOrPaths);
  return readTextEntries(
    await Promise.all(
      pathOrPaths.map(async (path) => [
        path,
        textDecoder.decode(await readSingleFile(runtime, path, options))
      ])
    )
  );
}
async function readSingleFile(runtime, path, options = {}) {
  const result = await runtime.transport.readFile({
    ...options,
    path,
    sandboxId: runtime.sandboxId
  });
  return result.content;
}
async function writeFile(runtime, pathOrFiles, contentOrOptions, maybeOptions = {}) {
  if (typeof pathOrFiles !== "string") {
    const options = contentOrOptions;
    validateRequestOptions(options ?? {});
    validateFileWrites(pathOrFiles);
    await Promise.all(
      normalizeFileWrites(pathOrFiles).map(
        (file) => writeSingleFile(runtime, file.path, file.content, options ?? {})
      )
    );
    return;
  }
  await writeSingleFile(runtime, pathOrFiles, contentOrOptions, maybeOptions);
}
async function writeSingleFile(runtime, path, content, options = {}) {
  validateRequestOptions(options);
  await runtime.transport.writeFile({
    ...options,
    content: normalizeFileContent(content),
    path,
    sandboxId: runtime.sandboxId
  });
}
function readEntries(entries) {
  return Object.fromEntries(entries);
}
function readTextEntries(entries) {
  return Object.fromEntries(entries);
}

// src/sandbox/logs.ts
function createSandboxLogs(runtime) {
  return {
    read: (options) => readLogs(runtime, options),
    stream: (options) => streamLogs(runtime, options),
    streamEntries: (options) => streamLogEntries(runtime, options),
    streamRaw: (options) => streamRawLogs(runtime, options)
  };
}
async function readLogs(runtime, options = {}) {
  validateLogReadOptions(options);
  const stream = await streamLogs(runtime, options);
  const lines = [];
  try {
    for await (const line of stream) {
      lines.push(line);
    }
  } finally {
    await stream.cancel().catch(() => void 0);
  }
  return lines;
}
async function streamLogs(runtime, options = {}) {
  validateLogStreamOptions(options);
  return await runtime.transport.streamLogs({
    ...options,
    mode: "lines",
    sandboxId: runtime.sandboxId
  });
}
async function streamLogEntries(runtime, options = {}) {
  validateLogStreamOptions(options);
  return await runtime.transport.streamLogs({
    ...options,
    mode: "entries",
    sandboxId: runtime.sandboxId
  });
}
async function streamRawLogs(runtime, options = {}) {
  validateLogStreamOptions(options);
  return await runtime.transport.streamLogs({
    ...options,
    mode: "raw",
    sandboxId: runtime.sandboxId
  });
}

// src/sandbox/wait.ts
var DEFAULT_WAIT_INTERVAL_MS = 1e3;
var DEFAULT_WAIT_TIMEOUT_MS = 6e4;
var DEFAULT_WAIT_TARGET_STATUS = "running";
var TERMINAL_STATUSES = /* @__PURE__ */ new Set(["completed", "failed", "terminated"]);
var WAIT_OPERATION = "Wait for sandbox";
async function waitForSandbox(runtime, options = {}) {
  validateWaitOptions(options);
  const intervalMs = options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const targetStatus = options.targetStatus ?? DEFAULT_WAIT_TARGET_STATUS;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    throwIfAborted(options.signal);
    const status = await getStatusForWait(runtime, options.signal);
    if (status === targetStatus) {
      return;
    }
    if (status !== void 0 && TERMINAL_STATUSES.has(status)) {
      throw new CWSandboxTransportError(
        `Sandbox '${runtime.sandboxId}' reached terminal status '${status}' before '${targetStatus}'.`,
        {
          operation: WAIT_OPERATION,
          sandboxId: runtime.sandboxId
        }
      );
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new CWSandboxTimeoutError(
        `Timed out waiting for sandbox '${runtime.sandboxId}' to reach status '${targetStatus}'.`,
        {
          operation: WAIT_OPERATION,
          sandboxId: runtime.sandboxId
        }
      );
    }
    await sleep(Math.min(intervalMs, remainingMs), options.signal);
  }
}
async function getStatusForWait(runtime, signal) {
  try {
    const result = await runtime.transport.get({
      ...signal === void 0 ? {} : { signal },
      sandboxId: runtime.sandboxId
    });
    return result.status;
  } catch (error) {
    if (error instanceof CWSandboxUnavailableError) {
      return void 0;
    }
    throw error;
  }
}
function throwIfAborted(signal) {
  signal?.throwIfAborted();
}
function sleep(timeoutMs, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      try {
        signal?.throwIfAborted();
      } catch (error) {
        reject(error);
      }
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// src/sandbox.ts
var Sandbox = class {
  commands;
  files;
  logs;
  sandboxId;
  runtime;
  constructor(options) {
    this.sandboxId = options.sandboxId;
    this.runtime = {
      sandboxId: this.sandboxId,
      transport: options.transport
    };
    this.commands = createSandboxCommands(this.runtime);
    this.files = createSandboxFiles(this.runtime);
    this.logs = createSandboxLogs(this.runtime);
  }
  async exec(command, options = {}) {
    return execCommand(this.runtime, command, options);
  }
  async getStatus(options = {}) {
    validateRequestOptions(options);
    const result = await this.runtime.transport.get({
      ...options,
      sandboxId: this.sandboxId
    });
    return result.status;
  }
  async wait(options = {}) {
    await waitForSandbox(this.runtime, options);
    return this;
  }
  async stop(options = {}) {
    validateStopOptions(options);
    await this.runtime.transport.stop({
      ...options,
      sandboxId: this.sandboxId
    });
  }
  async [Symbol.asyncDispose]() {
    await this.stop();
  }
  async delete(options = {}) {
    validateRequestOptions(options);
    await this.runtime.transport.delete({
      ...options,
      sandboxId: this.sandboxId
    });
  }
};

// src/client.ts
var SandboxClient = class {
  transport;
  constructor(options) {
    this.transport = options.transport;
  }
  /**
   * Create a long-lived sandbox and wait until it is ready for SDK operations.
   *
   * Uses the SDK default keep-alive command for the sandbox main process. Pass
   * `waitUntilRunning: false` to resolve after the backend accepts the start
   * request instead of waiting for lifecycle readiness.
   */
  async create(options = {}) {
    return this.run(DEFAULT_KEEP_ALIVE_COMMAND, options);
  }
  /**
   * Start a sandbox with a custom main process and wait until it is running.
   *
   * The command runs as the sandbox's main process and drives sandbox logs.
   * Pass `waitUntilRunning: false` to resolve after the backend accepts the
   * start request.
   */
  async run(command, options = {}) {
    const transport = this.transport;
    const normalizedCommand = normalizeCommand(command);
    validateSandboxRunOptions(options);
    const { waitUntilRunning, ...startOptions } = options;
    const result = await transport.start({ ...startOptions, command: normalizedCommand });
    const sandbox = new Sandbox({
      sandboxId: result.sandboxId,
      transport
    });
    if (waitUntilRunning !== false) {
      await sandbox.wait({
        ...options.signal === void 0 ? {} : { signal: options.signal },
        ...options.timeoutMs === void 0 ? {} : { timeoutMs: options.timeoutMs }
      });
    }
    return sandbox;
  }
  async fromId(sandboxId, options = {}) {
    validateRequestOptions(options);
    await this.transport.get({ ...options, sandboxId });
    return new Sandbox({
      sandboxId,
      transport: this.transport
    });
  }
  async list(options = {}) {
    validateListSandboxesOptions(options);
    return this.transport.list(options);
  }
  async delete(sandboxId, options = {}) {
    validateRequestOptions(options);
    await this.transport.delete({ ...options, sandboxId });
  }
  async withSandbox(commandOrCallback, callbackOrOptions, options = {}) {
    const sandbox = typeof commandOrCallback === "function" ? await this.create(callbackOrOptions ?? {}) : await this.run(commandOrCallback, options);
    const callback = typeof commandOrCallback === "function" ? commandOrCallback : callbackOrOptions;
    let callbackResult;
    try {
      callbackResult = {
        ok: true,
        value: await callback(sandbox)
      };
    } catch (error) {
      callbackResult = { error, ok: false };
    }
    try {
      await sandbox.stop();
    } catch (error) {
      if (callbackResult.ok) {
        throw error;
      }
    }
    if (!callbackResult.ok) {
      throw callbackResult.error;
    }
    return callbackResult.value;
  }
};

export {
  CWSandboxError,
  isCWSandboxError,
  CWSandboxConfigurationError,
  CWSandboxNotImplementedError,
  CWSandboxTransportError,
  CWSandboxAuthenticationError,
  CWSandboxNotFoundError,
  CWSandboxTimeoutError,
  CWSandboxUnavailableError,
  CWSandboxResourceExhaustedError,
  CWSandboxValidationError,
  commandForWorkingDirectory,
  DEFAULT_KEEP_ALIVE_COMMAND,
  normalizeMountedFiles,
  normalizeFileContent,
  normalizePorts,
  isAdvancedResources,
  validateRequestOptions,
  Sandbox,
  SandboxClient
};
//# sourceMappingURL=chunk-Z66QY2W7.js.map