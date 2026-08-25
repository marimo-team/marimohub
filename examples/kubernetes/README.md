# marimohub on Kubernetes (native kernels)

A minimal, copy-pasteable example of running marimohub with the **`kubernetes`**
compute backend, where each notebook kernel is a native Pod the control plane
creates in a dedicated namespace.

See [docs/deploying/kubernetes.md](../../docs/deploying/kubernetes.md) for the
full guide. This folder is illustrative — adapt names, image, and TLS to your
cluster.

## What's here

| File                                   | Purpose                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [`rbac.yaml`](./rbac.yaml)             | Kernel namespace + ServiceAccount + Role/RoleBinding granting the control plane just enough to manage kernel Pods/Services/Ingresses. |
| [`deployment.yaml`](./deployment.yaml) | The marimohub API + maintenance Deployments and a Service, wired to the ServiceAccount and a config Secret.                           |

## Prerequisites

1. **Bake the k8s client into the server image.** `@kubernetes/client-node` is a
   bring-your-own dependency. In your image build, run
   `pnpm add @kubernetes/client-node` (or `npm i @kubernetes/client-node`).
2. **A sandbox image** with marimo + uv + python3 + git
   (`MARIMOHUB_COMPUTE_IMAGE`).
3. **An ingress controller**, a wildcard DNS record `*.hub.example.com`, and
   either a wildcard TLS secret `marimo-kernels-wildcard-tls` in the
   `marimo-kernels` namespace or an ingress-controller default certificate so
   each `https://<id>.hub.example.com` kernel URL resolves.
4. A **config Secret** `marimohub-config` holding every `MARIMOHUB_*` variable
   (storage / compute / auth). The compute keys for this backend:

   ```bash
   MARIMOHUB_COMPUTE_BACKEND=kubernetes
   MARIMOHUB_COMPUTE_IMAGE=ghcr.io/orgname/marimo-sandbox:latest
   MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME=hub.example.com
   MARIMOHUB_COMPUTE_KUBERNETES_NAMESPACE=marimo-kernels
   MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_CLASS=traefik
   MARIMOHUB_COMPUTE_KUBERNETES_TLS_SECRET=marimo-kernels-wildcard-tls
   ```

   On OpenShift, you can use the default ingress certificate instead of a named
   secret. Remove or comment out `MARIMOHUB_COMPUTE_KUBERNETES_TLS_SECRET` from
   the block above, change `MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_CLASS` to the
   cluster's IngressClass (usually `openshift-default`; verify with
   `oc get ingressclass`), then add:

   ```bash
   MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_TLS_MODE=controller-default
   MARIMOHUB_COMPUTE_KUBERNETES_INGRESS_ANNOTATIONS='{"route.openshift.io/termination":"edge"}'
   ```

## Apply

```bash
kubectl apply -f rbac.yaml
kubectl -n marimohub create secret generic marimohub-config --from-env-file=.env
kubectl apply -f deployment.yaml
```

Kernel Pods/Services/Ingresses appear in `marimo-kernels` while a notebook is
open and are deleted on teardown:

```bash
kubectl -n marimo-kernels get pods,svc,ingress -l app.kubernetes.io/managed-by=marimohub
```
