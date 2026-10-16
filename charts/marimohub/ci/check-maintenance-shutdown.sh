#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."

for timeout in 1 120 300 86400; do
  helm template test charts/marimohub --set "maintenance.shutdownTimeoutSeconds=$timeout" | ruby -ryaml -e '
    deployments = YAML.load_stream(STDIN.read).compact.select { |doc| doc["kind"] == "Deployment" }
    deployments.each do |deployment|
      maintenance = deployment.dig("metadata", "labels", "app.kubernetes.io/component") == "maintenance"
      pod = deployment.dig("spec", "template", "spec")
      container = pod["containers"].first
      env = container["env"].to_h { |entry| [entry["name"], entry["value"]] }
      if maintenance
        abort "incorrect drain timeout" unless env["MARIMOHUB_SHUTDOWN_TIMEOUT_SECONDS"] == ARGV[0]
        abort "insufficient termination grace" unless pod["terminationGracePeriodSeconds"] == ARGV[0].to_i + 20
        abort "incorrect maintenance probe" unless container.dig("livenessProbe", "httpGet", "path") == "/api/health/maintenance"
      else
        abort "API drain changed" if env.key?("MARIMOHUB_SHUTDOWN_TIMEOUT_SECONDS")
        abort "API termination grace changed" if pod.key?("terminationGracePeriodSeconds")
        abort "incorrect API probe" unless container.dig("livenessProbe", "httpGet", "path") == "/api/health"
      end
    end
  ' "$timeout"
done

for invalid in 0 -1 1.5 86401 abc; do
  if error=$(helm template test charts/marimohub --set "maintenance.shutdownTimeoutSeconds=$invalid" 2>&1); then
    echo "Accepted invalid shutdown timeout: $invalid" >&2
    exit 1
  fi
  grep -Fq 'maintenance.shutdownTimeoutSeconds must be between 1 and 86400' <<< "$error"
done

for maintenance in true false; do
  if error=$(helm template test charts/marimohub \
    --set "maintenance.enabled=$maintenance" \
    --set 'extraEnv[0].name=MARIMOHUB_SHUTDOWN_TIMEOUT_SECONDS' \
    --set-string 'extraEnv[0].value=300' 2>&1); then
    echo "Accepted shutdown timeout through extraEnv (maintenance.enabled=$maintenance)" >&2
    exit 1
  fi
  grep -Fq 'Use maintenance.shutdownTimeoutSeconds instead of extraEnv for the shutdown timeout' <<< "$error"
done

for source in config secrets.data; do
  if error=$(helm template test charts/marimohub \
    --set-string "$source.MARIMOHUB_SHUTDOWN_TIMEOUT_SECONDS=300" 2>&1); then
    echo "Accepted shutdown timeout through $source" >&2
    exit 1
  fi
  grep -Fq "Use maintenance.shutdownTimeoutSeconds instead of $source for the shutdown timeout" <<< "$error"
done

ruby -ryaml -e '
  ARGV.each do |path|
    documents = YAML.load_stream(File.read(path)).compact
    deployment = documents.find { |doc| doc["kind"] == "Deployment" && doc.dig("metadata", "name") == "marimohub-maintenance" }
    abort "missing maintenance Deployment: #{path}" unless deployment
    pod = deployment.dig("spec", "template", "spec")
    env = pod["containers"].first["env"].to_h { |entry| [entry["name"], entry["value"]] }
    abort "incorrect maintenance drain timeout: #{path}" unless env["MARIMOHUB_SHUTDOWN_TIMEOUT_SECONDS"] == "120"
    abort "insufficient maintenance termination grace: #{path}" unless pod["terminationGracePeriodSeconds"] == 140
  end
' apps/server/k8s/deployment.yaml examples/kubernetes/deployment.yaml

echo 'Maintenance shutdown checks passed.'
