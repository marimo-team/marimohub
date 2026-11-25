# @marimo-hub/compute-kubernetes

Compute adapter running each kernel sandbox as a Kubernetes pod.

Part of [marimohub](../../README.md). See [docs/compute.md](../../docs/compute.md) for configuration.

## Process logs

Detached processes write stdout and stderr directly to separate files in `/tmp`.
Crash diagnostics and `getLogs()` read stdout followed by stderr, without preserving order between the streams.
The returned PID identifies the command. A detached supervisor reaps the command and its log follower.

The follower copies stderr to `/proc/1/fd/2` for `kubectl logs` and node log collectors.
Stdout stays in the local file. If Python or the destination is unavailable, the local files still capture both streams.
Forwarding uses nonblocking writes. If the destination is full or fails, forwarded bytes can be lost without blocking the command.
The local stderr file retains those bytes until the pod is deleted.

Raw stderr can contain user data and duplicate records sent through OTLP.
Retention after pod deletion depends on an external log collector.
