# @marimo-hub/auth-proxy-header

Authenticates requests from a trusted SSO proxy. It reads identity headers or verifies an IAP-compatible ES256 assertion.

CAUTION: In header mode, block direct access to marimohub. The proxy must remove client-supplied identity headers.

See the [authentication guide](../../docs/auth.md) for configuration.
