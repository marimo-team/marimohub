<!-- Setup snippet — included by docs/compute.md and rendered in the deployment wizard. -->

Run each kernel as a Pod in your own cluster. Before setting the env, make sure
the cluster is ready:

1. **Bake the client in:** `pnpm add @kubernetes/client-node` (bring-your-own
   dependency) and rebuild your server image.
2. **Grant RBAC:** marimohub's ServiceAccount needs `pods`, `services`, and
   `ingresses` in the kernel namespace.
3. **Wildcard ingress + TLS:** an ingress controller, a `*.{host}` DNS record,
   and either a matching wildcard TLS secret or an ingress-controller default
   certificate so each `{id}.{host}` kernel URL is HTTPS.
4. **Set the env:**

```bash
MARIMOHUB_COMPUTE_BACKEND=kubernetes
MARIMOHUB_COMPUTE_IMAGE=ghcr.io/orgname/marimo-sandbox:latest
MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME=hub.example.com           # kernels at https://<id>.hub.example.com
MARIMOHUB_COMPUTE_KUBERNETES_NAMESPACE=marimo-kernels
MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_CLASS=traefik
MARIMOHUB_COMPUTE_KUBERNETES_TLS_SECRET=marimo-kernels-wildcard-tls
# For OpenShift, replace `traefik` above with the cluster's IngressClass
# (usually `openshift-default`; verify with `oc get ingressclass`), remove or
# comment out the TLS_SECRET line, then uncomment these settings:
# MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_TLS_MODE=controller-default
# MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_ANNOTATIONS='{"route.openshift.io/termination":"edge"}'
# Optional per-kernel resources:
# MARIMOHUB_COMPUTE_KUBERNETES_CPU=2  MARIMOHUB_COMPUTE_KUBERNETES_MEMORY=4Gi  MARIMOHUB_COMPUTE_KUBERNETES_GPU=1
# Optional tuning:
# MARIMOHUB_COMPUTE_KUBERNETES_IMAGE_PULL_POLICY=IfNotPresent  # default: Always for :latest, else IfNotPresent
# MARIMOHUB_COMPUTE_KUBERNETES_POD_READY_TIMEOUT_SECONDS=120
```

See [Deploying → Kubernetes](/deploying/kubernetes) for the full RBAC + ingress recipe.

::: tip Most control, runs on your own cluster
Best when you already operate Kubernetes and want kernels to stay inside your
network with your own resource limits and GPUs.
:::

::: warning The most setup of any backend
You own the ingress, DNS, TLS, and RBAC. If kernels never become reachable, the
wildcard DNS/TLS is the usual culprit. For a single host without a cluster,
`docker` is far simpler; for zero infra, use `modal`.
:::

::: tip Slow kernel starts?
Pin the image by digest (not `:latest`) and pre-pull it on kernel nodes — see
[Startup latency](/deploying/kubernetes#startup-latency).
:::
