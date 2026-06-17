<!-- Setup snippet — included by docs/auth.md and rendered in the deployment wizard. -->

A fixed, unauthenticated identity for **local development only** — never use it
in production (it lets anyone in as the same user).

```bash
MARIMOHUB_AUTH_BACKEND=dev
# all optional — these are the defaults:
MARIMOHUB_AUTH_DEV_USER_ID=user
MARIMOHUB_AUTH_DEV_EMAIL=user@localhost
MARIMOHUB_AUTH_DEV_NAME='Local Dev'
```
