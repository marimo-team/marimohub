Use this backend behind oauth2-proxy, Tailscale Serve, Google IAP, or another SSO proxy.

CAUTION: In header mode, block direct access to marimohub. The proxy must remove client-supplied identity headers.

Both modes require `MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS`. Set `*` only to allow all authenticated domains.

oauth2-proxy can supply the default marimohub headers:

```bash
MARIMOHUB_AUTH_BACKEND=proxy-header
MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS=example.com
```

oauth2-proxy sends these headers when `--pass-user-headers=true`. Current releases enable this option by default.

If you disable this option, marimohub receives no identity and returns 401.

For Nginx `auth_request`, enable `--set-xauthrequest`. Copy both response headers upstream. Then set their names in marimohub:

```bash
MARIMOHUB_AUTH_PROXY_HEADER=X-Auth-Request-Email,X-Auth-Request-User
```

For a custom pair, set two comma-separated names:

```bash
MARIMOHUB_AUTH_PROXY_HEADER=X-Auth-Email,X-Auth-Subject
```

Tailscale Serve supplies both values in one header:

```bash
MARIMOHUB_AUTH_BACKEND=proxy-header
MARIMOHUB_AUTH_PROXY_HEADER=Tailscale-User-Login
MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS=example.com
```

For Google IAP, set the signed-header JWT audience:

```bash
MARIMOHUB_AUTH_BACKEND=proxy-header
MARIMOHUB_AUTH_PROXY_JWT_AUDIENCE=/projects/123456789/global/backendServices/987654321
MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS=example.com
```

The audience selects JWT mode. The adapter uses the IAP header, issuer, and JWKS URL by default.

You can override these values for an IAP-compatible deployment:

```bash
MARIMOHUB_AUTH_PROXY_HEADER=X-Verified-Assertion
MARIMOHUB_AUTH_PROXY_JWT_ISSUER=https://issuer.example.com
MARIMOHUB_AUTH_PROXY_JWKS_URL=https://issuer.example.com/.well-known/jwks.json
```

JWT mode accepts ES256 assertions only. It verifies the signature, issuer, audience, lifetime, subject, and email.

See the provider guides for [oauth2-proxy headers](https://oauth2-proxy.github.io/oauth2-proxy/configuration/overview/), [Tailscale Serve headers](https://tailscale.com/docs/features/tailscale-serve#identity-headers), and [Google IAP signed headers](https://cloud.google.com/iap/docs/signed-headers-howto).
