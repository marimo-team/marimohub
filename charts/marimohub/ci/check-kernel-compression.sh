#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../../.."

helm template test charts/marimohub | ruby -ryaml -e '
  documents = YAML.load_stream(STDIN.read).compact
  abort "kernel compression must be opt-in" if documents.any? { |doc| doc["kind"] == "Middleware" }
  documents.select { |doc| doc["kind"] == "Deployment" }.each do |deployment|
    env = deployment.dig("spec", "template", "spec", "containers").first.fetch("env")
    abort "middleware wiring must be opt-in" if env.any? { |entry| entry["name"] == "MARIMOHUB_COMPUTE_COREWEAVE_INGRESS_MIDDLEWARES" }
  end
'

if error=$(helm template test charts/marimohub \
  --set sandboxIngress.compression.enabled=true 2>&1); then
  echo 'Expected kernel compression without a namespace to fail'
  exit 1
fi
grep -Fq 'sandboxIngress.namespace is required for kernel compression' <<< "$error"

helm template test charts/marimohub \
  -f charts/marimohub/ci/kernel-compression-values.yaml | ruby -ryaml -e '
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
    expected = "#{namespace}-#{name}@kubernetescrd"
    deployments = documents.select { |doc| doc["kind"] == "Deployment" }
    abort "expected API and maintenance deployments" unless deployments.size == 2
    deployments.each do |deployment|
      container = deployment.dig("spec", "template", "spec", "containers").first
      env = container.fetch("env").to_h { |entry| [entry["name"], entry["value"]] }
      abort "incorrect kernel ingress namespace" unless env["MARIMOHUB_COMPUTE_COREWEAVE_INGRESS_NAMESPACE"] == namespace
      abort "middleware reference does not match the resource" unless env["MARIMOHUB_COMPUTE_COREWEAVE_INGRESS_MIDDLEWARES"] == expected
      abort "external annotations overridden" if env.key?("MARIMOHUB_COMPUTE_COREWEAVE_INGRESS_ANNOTATIONS")
      abort "external Secret missing" unless container.fetch("envFrom").include?({"secretRef" => {"name" => "external-config", "optional" => true}})
    end
  '

helm template test charts/marimohub \
  -f charts/marimohub/ci/kernel-compression-values.yaml \
  --set-string config.MARIMOHUB_COMPUTE_COREWEAVE_INGRESS_NAMESPACE=sandboxes \
  --set-json 'config.MARIMOHUB_COMPUTE_COREWEAVE_INGRESS_ANNOTATIONS="{\"traefik.ingress.kubernetes.io/router.middlewares\":\"sandboxes-auth@kubernetescrd\",\"example.com/key\":\"value\"}"' | ruby -ryaml -rjson -e '
    documents = YAML.load_stream(STDIN.read).compact
    config = documents.find { |doc| doc["kind"] == "ConfigMap" }.fetch("data")
    annotations = JSON.parse(config.fetch("MARIMOHUB_COMPUTE_COREWEAVE_INGRESS_ANNOTATIONS"))
    abort "existing middleware changed" unless annotations["traefik.ingress.kubernetes.io/router.middlewares"] == "sandboxes-auth@kubernetescrd"
    abort "existing annotation changed" unless annotations["example.com/key"] == "value"
  '

for source in config secrets.data; do
  if error=$(helm template test charts/marimohub \
    -f charts/marimohub/ci/kernel-compression-values.yaml \
    --set-string "$source.MARIMOHUB_COMPUTE_COREWEAVE_INGRESS_NAMESPACE=wrong" 2>&1); then
    echo "Accepted conflicting namespace in $source" >&2
    exit 1
  fi
  grep -Fq 'must match sandboxIngress.namespace' <<< "$error"
  if error=$(helm template test charts/marimohub \
    -f charts/marimohub/ci/kernel-compression-values.yaml \
    --set-string "$source.MARIMOHUB_COMPUTE_COREWEAVE_INGRESS_MIDDLEWARES=other@file" 2>&1); then
    echo "Accepted middleware override in $source" >&2
    exit 1
  fi
  grep -Fq 'is managed by sandboxIngress.compression' <<< "$error"
done

for key in MARIMOHUB_COMPUTE_COREWEAVE_INGRESS_NAMESPACE MARIMOHUB_COMPUTE_COREWEAVE_INGRESS_MIDDLEWARES; do
  if error=$(helm template test charts/marimohub \
    -f charts/marimohub/ci/kernel-compression-values.yaml \
    --set-string "extraEnv[0].name=$key" \
    --set-string 'extraEnv[0].value=override' 2>&1); then
    echo "Accepted override in extraEnv: $key" >&2
    exit 1
  fi
  grep -Fq 'is managed by sandboxIngress.compression' <<< "$error"
done

echo 'Kernel compression checks passed.'
