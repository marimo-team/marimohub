<!-- Setup snippet — included by docs/compute.md and rendered in the deployment wizard. -->

No setup — just select it:

```bash
MARIMOHUB_COMPUTE_BACKEND=none
```

::: info Notebooks are browsable, but won't run
Use this to stand up the control plane (storage + auth + UI) before you've wired
compute. Starting a kernel fails until you switch to a real backend.
:::
