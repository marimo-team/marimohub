import {
  DEFAULT_CONTAINER_IMAGE,
  GrpcSandboxTransport
} from "../chunk-W5QKV4YH.js";
import {
  CWSandboxConfigurationError,
  DEFAULT_KEEP_ALIVE_COMMAND,
  SandboxClient
} from "../chunk-Z66QY2W7.js";

// src/node/index.ts
var DEFAULT_BASE_URL = "https://api.cwsandbox.com";
function createSandboxClient(options) {
  const apiKey = options.apiKey.trim();
  if (apiKey === "") {
    throw new CWSandboxConfigurationError("CWSandbox API key is required.");
  }
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  return new SandboxClient({
    transport: new GrpcSandboxTransport({
      apiKey,
      baseUrl
    })
  });
}
function createSandboxClientFromEnv(env = process.env) {
  const apiKey = env.CWSANDBOX_API_KEY ?? "";
  const baseUrl = env.CWSANDBOX_BASE_URL?.trim();
  return createSandboxClient({
    apiKey,
    ...baseUrl ? { baseUrl } : {}
  });
}
function normalizeBaseUrl(baseUrl) {
  const value = baseUrl?.trim().replace(/\/+$/, "");
  return value === void 0 || value === "" ? DEFAULT_BASE_URL : value;
}
export {
  DEFAULT_BASE_URL,
  DEFAULT_CONTAINER_IMAGE,
  DEFAULT_KEEP_ALIVE_COMMAND,
  GrpcSandboxTransport,
  createSandboxClient,
  createSandboxClientFromEnv
};
//# sourceMappingURL=index.js.map