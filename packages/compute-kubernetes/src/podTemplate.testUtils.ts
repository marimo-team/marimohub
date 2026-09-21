export const projectedToken = `
apiVersion: v1
kind: Pod
metadata:
  labels:
    team: fabric
  annotations:
    example.com/purpose: notebook
spec:
  serviceAccountName: fabric-marimohub-kernel
  automountServiceAccountToken: false
  enableServiceLinks: false
  restartPolicy: Never
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
          drop: [ALL]
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
`;

export const withSpec = (spec: unknown) => ({ spec });
export const withContainer = (fields: Record<string, unknown>) =>
	withSpec({ containers: [{ name: 'marimo', ...fields }] });
