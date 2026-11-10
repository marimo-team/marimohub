#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../../.."

helm template test charts/marimohub | ruby -ryaml -e '
  documents = YAML.load_stream(STDIN.read).compact
  abort "kernel compression must be opt-in" if documents.any? { |doc| doc["kind"] == "Middleware" }
'

if error=$(helm template test charts/marimohub \
  --set sandboxIngress.compression.enabled=true 2>&1); then
  echo 'Expected kernel compression without a namespace to fail'
  exit 1
fi
grep -Fq 'sandboxIngress.namespace is required for kernel compression' <<< "$error"

helm template test charts/marimohub \
  -f charts/marimohub/ci/kernel-compression-values.yaml | ruby -ryaml -rjson -e '
    documents = YAML.load_stream(STDIN.read).compact
    middlewares = documents.select { |doc| doc["kind"] == "Middleware" }
    abort "expected one compression middleware" unless middlewares.size == 1
    middleware = middlewares.first
    abort "incorrect Middleware API" unless middleware["apiVersion"] == "traefik.io/v1alpha1"
    name = middleware.dig("metadata", "name")
    namespace = middleware.dig("metadata", "namespace")
    abort "incorrect middleware name" unless name == "custom-hub-kernel-compress"
    abort "incorrect middleware namespace" unless namespace == "sandboxes"
    compression = middleware.fetch("spec").fetch("compress")
    abort "unsupported encodings" unless compression["encodings"] == ["zstd", "br", "gzip"]
    abort "SSE must remain uncompressed" unless compression["excludedContentTypes"] == ["text/event-stream"]
    abort "small responses must remain uncompressed" unless compression["minResponseBodyBytes"] == 1024
    config = documents.find { |doc| doc["kind"] == "ConfigMap" }.fetch("data")
    abort "incorrect kernel ingress namespace" unless config["MARIMOHUB_COMPUTE_COREWEAVE_INGRESS_NAMESPACE"] == namespace
    annotations = JSON.parse(config.fetch("MARIMOHUB_COMPUTE_COREWEAVE_INGRESS_ANNOTATIONS"))
    expected = "#{namespace}-#{name}@kubernetescrd"
    abort "middleware annotation does not match the resource" unless annotations["traefik.ingress.kubernetes.io/router.middlewares"] == expected
  '

echo 'Kernel compression checks passed (disabled, missing namespace, enabled with custom fullname).'
