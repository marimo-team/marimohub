Set the backend and module:

```bash
MARIMOHUB_STORAGE_BACKEND=library
MARIMOHUB_STORAGE_LIBRARY=/etc/marimohub/storage.mjs
```

The module must default-export an API version 1 storage manifest. Its factory
must return a complete `Bucket`. The server validates both at startup.

Only the Node server supports external adapters. Load only trusted code. It runs
in-process with server privileges. A storage adapter must provide atomic
conditional writes. It must implement `verifyConditionalWrites()` and set
`casScope` to `global` or `process`.
