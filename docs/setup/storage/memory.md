<!-- Setup snippet — included by docs/storage.md and rendered in the deployment wizard. -->

No external store — set the selector plus the explicit opt-in:

```bash
MARIMOHUB_STORAGE_BACKEND=memory
MARIMOHUB_ALLOW_EPHEMERAL_STORAGE=true   # required acknowledgement that this is volatile
```

::: danger Volatile — data is lost on restart
Everything lives in process memory and disappears when marimohub stops. It's for
local dev and tests only; the opt-in flag exists so it can never back a real
deployment by accident. Use `s3` or `gcs` for anything you want to keep.
:::
