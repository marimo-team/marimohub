# MinIO's community images and binary downloads are no longer available.
FROM golang:1.26.7-alpine3.24@sha256:28d89ee9cc0ff9fec75c82ca201e6bf7fdf9a679d4b7b24dfa04f2bb766bb468 AS build

# RELEASE.2025-09-07T16-13-09Z and RELEASE.2025-04-16T18-13-26Z.
ARG MINIO_VERSION=v0.0.0-20250907161309-07c3a429bfed
ARG MC_VERSION=v0.0.0-20250416181326-b00526b153a3
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOBIN=/out
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go install github.com/minio/mc@${MC_VERSION} && \
    go install github.com/minio/minio@${MINIO_VERSION}

FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
RUN apk add --no-cache ca-certificates
COPY --from=build /out/minio /out/mc /usr/local/bin/
EXPOSE 9000 9001
ENTRYPOINT ["minio"]
CMD ["server", "/data"]
