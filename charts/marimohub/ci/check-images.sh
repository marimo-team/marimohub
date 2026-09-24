#!/usr/bin/env bash
set -euo pipefail

chart=charts/marimohub
repository=ghcr.io/marimo-team/marimohub
version=$(ruby -ryaml -e 'puts YAML.load_file(ARGV[0]).fetch("appVersion")' "$chart/Chart.yaml")

check_image() {
  local expected=$1
  shift
  helm template test "$chart" --show-only templates/deployment.yaml "$@" |
    ruby -ryaml -e '
      pods = YAML.load_stream(STDIN.read).compact
      abort "missing deployment" if pods.empty?
      pods.each do |pod|
        pod.fetch("spec").fetch("template").fetch("spec").fetch("containers").each do |container|
          abort "unexpected image: #{container["image"]}" unless container["image"] == ARGV[0]
        end
      end
    ' "$expected"
}

check_image "$repository:$version"
check_image "$repository:custom" --set image.tag=custom
digest=sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
check_image "example.com/hub@$digest" --set image.repository=example.com/hub --set image.tag=ignored --set image.digest="$digest"
if helm template test "$chart" --set image.digest=sha256:invalid >/dev/null 2>&1; then
  echo 'Expected an invalid image digest to fail' >&2
  exit 1
fi
