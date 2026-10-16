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
  if helm template test charts/marimohub --set "maintenance.shutdownTimeoutSeconds=$invalid" >/dev/null 2>&1; then
    echo "Accepted invalid shutdown timeout: $invalid" >&2
    exit 1
  fi
done

if helm template test charts/marimohub \
  --set 'extraEnv[0].name=MARIMOHUB_SHUTDOWN_TIMEOUT_SECONDS' \
  --set-string 'extraEnv[0].value=300' >/dev/null 2>&1; then
  echo 'Accepted shutdown timeout through extraEnv' >&2
  exit 1
fi

echo 'Maintenance shutdown checks passed.'
