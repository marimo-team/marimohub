Set the backend and module:

```bash
MARIMOHUB_COMPUTE_BACKEND=library
MARIMOHUB_COMPUTE_LIBRARY=/etc/marimohub/compute.mjs
```

The module must default-export an API version 1 compute manifest. Its factory
must return a complete `SandboxProvider`. The server validates the first sandbox
against the `SandboxInstance` contract.

The Hub needs the kernel URL before launch to set the kernel's allowed origin.
Before launch, the Hub calls `prepareExposure` if the adapter implements it.
If `prepareExposure` returns a URL, the Hub uses that URL.
Otherwise, the Hub calls `exposePort` before launch.
In [proxy exposure](/compute#shared-settings), the Hub skips this call and uses its proxy URL.
If `exposePort` waits for a running kernel, implement `prepareExposure` to return a stable URL.
After readiness, the Hub calls `exposePort` again.
If the Hub got a URL before launch, it rejects a changed origin.

The adapter applies [compute profiles](/compute#compute-profiles) only when its
provider declares them. Set `capabilities.computeProfiles: true` for CPU and
memory, and `capabilities.gpuProfiles: true` for GPU requests. Each capability
flag must be a boolean, or startup fails. See
[external adapter libraries](https://github.com/marimo-team/marimohub/blob/main/development_docs/ports.md#external-adapter-libraries).

Only the Node server supports external adapters. Load only trusted code. It runs
in-process with server privileges.
