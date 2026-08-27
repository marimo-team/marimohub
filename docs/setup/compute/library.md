Set the backend and module:

```bash
MARIMOHUB_COMPUTE_BACKEND=library
MARIMOHUB_COMPUTE_LIBRARY=/etc/marimohub/compute.mjs
```

The module must default-export an API version 1 compute manifest. Its factory
must return a complete `SandboxProvider`. The server validates the first sandbox
against the `SandboxInstance` contract.

Only the Node server supports external adapters. Load only trusted code. It runs
in-process with server privileges.
