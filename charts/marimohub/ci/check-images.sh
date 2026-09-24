#!/usr/bin/env bash
set -euo pipefail

chart=charts/marimohub
repository=ghcr.io/marimo-team/marimohub
version=$(ruby -ryaml -e 'puts YAML.load_file(ARGV[0]).fetch("appVersion")' "$chart/Chart.yaml")

check_image() {
  local expected=$1
  local expected_version=$2
  shift 2
  helm install test "$chart" --dry-run=client --output json "$@" |
    ruby -rjson -ryaml -e '
      release = JSON.parse(STDIN.read)
      resources = YAML.load_stream(release.fetch("manifest")).compact
      deployments = resources.select { |resource| resource["kind"] == "Deployment" }
      abort "missing deployments" unless deployments.length == 2
      deployments.each do |pod|
        pod.fetch("spec").fetch("template").fetch("spec").fetch("containers").each do |container|
          abort "unexpected image: #{container["image"]}" unless container["image"] == ARGV[0]
        end
      end
      resources.each do |resource|
        version = resource.fetch("metadata").fetch("labels").fetch("app.kubernetes.io/version")
        abort "unexpected version label: #{version}" unless version == ARGV[1].tr(":", "-")[0, 63]
        abort "invalid version label: #{version}" unless version.match?(/\A[a-zA-Z0-9]([a-zA-Z0-9_.-]{0,61}[a-zA-Z0-9])?\z/)
      end
      notes = release.fetch("info").fetch("notes")
      abort "unexpected NOTES version" unless notes.start_with?("marimohub #{ARGV[1]} deployed as release test ")
      abort "unexpected NOTES image" unless notes.include?("Image:  #{ARGV[0]}\n")
    ' "$expected" "$expected_version"
}

check_image "$repository:$version" "$version"
check_image "$repository:$version" "$version" --set-string image.digest=
check_image "$repository:custom" custom --set image.tag=custom
digest=sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
check_image "example.com/hub@$digest" "$digest" --set image.repository=example.com/hub --set image.tag=ignored --set image.digest="$digest"
check_image "$repository@$digest" "$digest" --set image.digest="$digest"
for invalid in false true 0 1 null '[]' '{}' '"sha256:invalid"' '" "'; do
  if output=$(helm template test "$chart" --set-json "image.digest=$invalid" 2>&1); then
    echo "Expected image.digest=$invalid to fail" >&2
    exit 1
  fi
  if [[ "$output" != *'image.digest must be'* ]]; then
    echo "Expected a digest validation error for image.digest=$invalid: $output" >&2
    exit 1
  fi
done
