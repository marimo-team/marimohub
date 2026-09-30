#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../../.."

# Reload controllers read Deployment metadata, not pod-template annotations;
# keep the two settings separate for both API and maintenance workloads.
for maintenance in true false; do
  for configured in true false; do
    args=(--set "maintenance.enabled=$maintenance")
    if [[ "$configured" == true ]]; then
      args+=(--set-json 'deploymentAnnotations={"reloader.stakater.com/auto":"true","example.com/owner":"platform"}')
    fi
    helm template test charts/marimohub "${args[@]}" \
      --set-json 'podAnnotations={"example.com/pod-only":"yes"}' | ruby -ryaml -e '
      documents = YAML.load_stream(STDIN.read).compact
      deployments = documents.select { |doc| doc["kind"] == "Deployment" }
      expected_components = ARGV[0] == "true" ? ["api", "maintenance"] : ["api"]
      components = deployments.map { |doc| doc.dig("metadata", "labels", "app.kubernetes.io/component") }.sort
      abort "unexpected Deployments" unless components == expected_components
      expected = ARGV[1] == "true" ? {
        "reloader.stakater.com/auto" => "true",
        "example.com/owner" => "platform",
      } : nil
      deployments.each do |deployment|
        abort "incorrect Deployment annotations" unless deployment.dig("metadata", "annotations") == expected
        pod_annotations = deployment.dig("spec", "template", "metadata", "annotations") || {}
        abort "pod annotations lost" unless pod_annotations["example.com/pod-only"] == "yes"
        abort "Deployment annotations leaked into pod" if pod_annotations.key?("reloader.stakater.com/auto")
      end
    ' "$maintenance" "$configured"
  done
done

echo 'Deployment annotation checks passed (default/configured, maintenance enabled/disabled).'
