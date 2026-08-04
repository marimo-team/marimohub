{{/* Base name, overridable. */}}
{{- define "marimohub.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Fully-qualified release name. */}}
{{- define "marimohub.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Common labels. */}}
{{- define "marimohub.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "marimohub.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* Selector labels (stable across upgrades — never include version here). */}}
{{- define "marimohub.selectorLabels" -}}
app.kubernetes.io/name: {{ include "marimohub.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Resolved image ref: repository:(tag|appVersion). */}}
{{- define "marimohub.image" -}}
{{- printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion) -}}
{{- end -}}

{{/* Name of the Secret to consume via envFrom (existing or chart-managed). */}}
{{- define "marimohub.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "marimohub.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/*
Pod template, shared by the API and maintenance deployments.
Call with: (dict "root" $ "maintenance" true|false)
*/}}
{{- define "marimohub.podTemplate" -}}
{{- $root := .root -}}
{{- $v := $root.Values -}}
{{- $res := $v.resources -}}
{{- if .maintenance -}}{{- $res = $v.maintenance.resources -}}{{- end }}
metadata:
  labels:
    {{- include "marimohub.selectorLabels" $root | nindent 4 }}
    app.kubernetes.io/component: {{ if .maintenance }}maintenance{{ else }}api{{ end }}
    {{- with $v.podLabels }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
  {{- if or $v.podAnnotations $v.config $v.compute.profiles (ne $v.compute.profileOverride "none") }}
  annotations:
    {{- if or $v.config $v.compute.profiles (ne $v.compute.profileOverride "none") }}
    checksum/config: {{ include (print $root.Template.BasePath "/configmap.yaml") $root | sha256sum }}
    {{- end }}
    {{- with $v.podAnnotations }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
  {{- end }}
spec:
  enableServiceLinks: false
  {{- with $v.imagePullSecrets }}
  imagePullSecrets:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with $v.nodeSelector }}
  nodeSelector:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with $v.tolerations }}
  tolerations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with $v.affinity }}
  affinity:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- if and (not .maintenance) $v.topologySpreadConstraints }}
  topologySpreadConstraints:
    {{- range $v.topologySpreadConstraints }}
    - {{ toYaml . | nindent 6 | trim }}
      labelSelector:
        matchLabels:
          {{- include "marimohub.selectorLabels" $root | nindent 10 }}
          app.kubernetes.io/component: api
      # Balance only against pods of the same rollout, so a rolling update can't
      # converge the new replicas onto one node as the old ones drain.
      matchLabelKeys:
        - pod-template-hash
    {{- end }}
  {{- end }}
  securityContext:
    {{- toYaml $v.podSecurityContext | nindent 4 }}
  containers:
    - name: marimohub
      image: {{ include "marimohub.image" $root }}
      imagePullPolicy: {{ $v.image.pullPolicy }}
      securityContext:
        {{- toYaml $v.containerSecurityContext | nindent 8 }}
      {{- if or (not .maintenance) $v.metrics.enabled }}
      ports:
        {{- if not .maintenance }}
        - name: http
          containerPort: {{ $v.containerPort }}
        {{- end }}
        {{- if $v.metrics.enabled }}
        - name: metrics
          containerPort: {{ $v.metrics.port }}
        {{- end }}
      {{- end }}
      envFrom:
        {{- if or $v.config $v.compute.profiles (ne $v.compute.profileOverride "none") }}
        - configMapRef:
            name: {{ include "marimohub.fullname" $root }}-config
        {{- end }}
        # optional so the pods can roll before the secret exists; the app still
        # fails its own validation at boot if required secret vars are missing.
        - secretRef:
            name: {{ include "marimohub.secretName" $root }}
            optional: true
      env:
        # The maintenance cron runs on the singleton deployment ONLY. This
        # explicit env overrides any value coming from the ConfigMap/Secret.
        - name: MARIMOHUB_RUN_MAINTENANCE
          value: {{ if .maintenance }}"true"{{ else }}"false"{{ end }}
        {{- if $v.metrics.enabled }}
        - name: OTEL_METRICS_EXPORTER
          value: prometheus
        - name: OTEL_EXPORTER_PROMETHEUS_PORT
          value: {{ $v.metrics.port | quote }}
        {{- end }}
        {{- with $v.extraEnv }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
      {{- if not .maintenance }}
      readinessProbe:
        httpGet: { path: /api/health, port: {{ $v.containerPort }} }
        initialDelaySeconds: 5
        periodSeconds: 10
      livenessProbe:
        httpGet: { path: /api/health, port: {{ $v.containerPort }} }
        initialDelaySeconds: 10
        periodSeconds: 20
      {{- end }}
      resources:
        {{- toYaml $res | nindent 8 }}
      # readOnlyRootFilesystem is on; give Node a writable /tmp for any library
      # that uses os.tmpdir().
      volumeMounts:
        - name: tmp
          mountPath: /tmp
  volumes:
    - name: tmp
      emptyDir: {}
{{- end -}}
