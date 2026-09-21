<!-- Setup snippet — included by docs/compute.md and rendered in the deployment wizard. -->

Run each kernel as a Pod in your own cluster. Before setting the env, make sure
the cluster is ready:

1. **Bake the client in:** `pnpm add @kubernetes/client-node` (bring-your-own
   dependency) and rebuild your server image.
2. **Grant RBAC:** marimohub's ServiceAccount needs `pods` and `services` in the
   kernel namespace (`services` includes `update`, so a reconnect can reconcile
   the Service's ports — add it when upgrading). Subdomain exposure also needs
   `ingresses`.
3. **For subdomain exposure, configure ingress + TLS:** an ingress controller, a
   `*.{host}` DNS record, and either a matching wildcard TLS secret or an
   ingress-controller default certificate so each `{id}.{host}` kernel URL is
   HTTPS.
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
# For clusters whose admission policies require ownership labels or a pinned uid:
# MARIMOHUB_COMPUTE_KUBERNETES_POD_LABELS=team=data,app.kubernetes.io/part-of=marimohub
# MARIMOHUB_COMPUTE_KUBERNETES_RUN_AS_USER=1000  # also sets runAsNonRoot and fsGroup; the image workdir must be writable by this uid
```

`MARIMOHUB_COMPUTE_KUBERNETES_POD_LABELS` adds labels to Pods, Services, and
Ingresses. Kubernetes label syntax applies, including empty values such as `team=`.
The hub's management and selector labels take precedence.

`MARIMOHUB_COMPUTE_KUBERNETES_RUN_AS_USER` sets the Pod UID and matching
`fsGroup`, with `runAsNonRoot: true` except for UID `0`.
If unset, the hub uses the template security context or leaves it unset.
The UID must have write access to the image work directory. `fsGroup` affects
mounted volumes only.

#### Pod templates

Use a partial Pod manifest to configure volumes, environment variables, security
contexts, and scheduling. Mount the file into the **hub server**, for example
through a ConfigMap. Set its path, the kernel namespace, and the image:

```bash
MARIMOHUB_COMPUTE_KUBERNETES_POD_TEMPLATE_FILE=/etc/marimohub/kernel-pod.yaml
MARIMOHUB_COMPUTE_KUBERNETES_NAMESPACE=fabric-marimohub-kernels
MARIMOHUB_COMPUTE_IMAGE=registry.example.com/fabric/runtime:1.0.27
```

The server reads the file once at startup. After a file change, restart the
server. The updated template applies only to new Pods.

Example `kernel-pod.yaml`:

```yaml
apiVersion: v1
kind: Pod
spec:
  serviceAccountName: fabric-marimohub-kernel
  automountServiceAccountToken: false
  enableServiceLinks: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: marimo
      env:
        - name: FABRIC_URL
          value: https://fabric-gateway.example.com
        - name: FABRIC_TOKEN_PATH
          value: /var/run/secrets/marimohub/token
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop: ['ALL']
      volumeMounts:
        - name: gateway-token
          mountPath: /var/run/secrets/marimohub
          readOnly: true
  volumes:
    - name: gateway-token
      projected:
        defaultMode: 0444
        sources:
          - serviceAccountToken:
              audience: fabric-gateway
              expirationSeconds: 600
              path: token
```

[Kubernetes rotates the projected token](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/).
The application must reread the file after rotation. `subPath` mounts do not
receive updates.

**Format.** Use one YAML 1.1 or JSON object. YAML mode `0444` equals JSON mode
`292`. Quote strings such as `"true"`, `"yes"`, and `"123"` in environment
variables, labels, and annotations. All template sections are optional.
If supplied, `apiVersion` must be `v1`, `kind` must be `Pod`, and `containers`
must contain one entry named `marimo`.

**Precedence:** explicit environment configuration > template > adapter defaults.
Lists remain intact unless explicitly replaced. The hub does not deep-merge
templates. Template labels and annotations apply only to Pods.

| Environment variable                             | Template override                                                                         |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `MARIMOHUB_COMPUTE_KUBERNETES_SERVICE_ACCOUNT`   | Replaces `spec.serviceAccountName`.                                                       |
| `MARIMOHUB_COMPUTE_KUBERNETES_IMAGE_PULL_SECRET` | Replaces the entire `imagePullSecrets` list.                                              |
| `MARIMOHUB_COMPUTE_KUBERNETES_IMAGE_PULL_POLICY` | Replaces the container pull policy.                                                       |
| `MARIMOHUB_COMPUTE_KUBERNETES_RUN_AS_USER`       | Replaces Pod `runAsUser`, `runAsNonRoot`, and `fsGroup`. Preserves other security fields. |
| `MARIMOHUB_COMPUTE_KUBERNETES_POD_LABELS`        | Overrides matching labels. Also applies to Services and Ingresses.                        |

Container security fields take precedence over Pod security fields.

**Managed fields.** Templates must omit:

- Metadata other than `labels` and `annotations`, including the Pod name and
  namespace. Reserved management labels and the sandbox identity annotation
  are also prohibited.
- Container `image`, `command`, `args`, `ports`, and `resources`. MarimoHub
  supplies these from runtime configuration and compute profiles.
- Extra containers, `initContainers`, `ephemeralContainers`, Pod-level
  `resources`, and the deprecated `serviceAccount` alias.

`restartPolicy` must be absent or `Never`. Other supported fields include
`nodeSelector`, `tolerations`, `affinity`, `envFrom`, and `terminationGracePeriodSeconds`.

**Compatibility.** At startup, the hub checks common field shapes, duplicate
names, and volume references. Some nested objects reject unfamiliar
fields. The Kubernetes SDK can silently drop other unfamiliar fields before
submission. Custom labels and annotations are supported. Kubernetes performs
full schema and admission checks on the submitted Pod.

#### Proxy exposure

For proxy exposure, omit `MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME` and the Ingress/TLS
settings. marimohub uses the internal Service URL and does not manage Ingresses,
so a `MARIMOHUB_COMPUTE_KUBERNETES_HOSTNAME_TEMPLATE` that uses `{host}` or
`{token}` is rejected at boot:

```bash
MARIMOHUB_COMPUTE_BACKEND=kubernetes
MARIMOHUB_COMPUTE_IMAGE=ghcr.io/orgname/marimo-sandbox:latest
MARIMOHUB_COMPUTE_KUBERNETES_NAMESPACE=marimo-kernels
MARIMOHUB_SANDBOX_EXPOSURE=proxy
MARIMOHUB_SANDBOX_PROXY_ACK_UNTRUSTED=true
```

::: danger Existing subdomain deployment
Before you select proxy exposure, complete the required
[session drain](/deploying/kubernetes#changing-from-subdomain-to-proxy). Proxy
mode cannot delete an Ingress from an old subdomain session.
:::

See [Deploying → Kubernetes](/deploying/kubernetes) for the full RBAC + ingress recipe.

::: tip Most control, runs on your own cluster
Best when you already operate Kubernetes and want kernels to stay inside your
network with your own resource limits and GPUs.
:::

::: warning The most setup of any backend
Subdomain exposure requires ingress, DNS, TLS, and RBAC. For one host without a
cluster, use `docker`. For hosted compute, use `modal`.
:::

::: tip Slow kernel starts?
Pin the image by digest (not `:latest`) and pre-pull it on kernel nodes — see
[Startup latency](/deploying/kubernetes#startup-latency).
:::
