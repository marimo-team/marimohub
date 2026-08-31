# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

ARG BASE_IMAGE=ghcr.io/marimo-team/marimo-sandbox:latest
FROM ${BASE_IMAGE}

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server \
 && mkdir -p /run/sshd \
 && usermod --password NP appuser \
 && rm -rf /var/lib/apt/lists/*

COPY marimohub-ssh marimohub-ssh-shell /usr/local/bin/
RUN chmod 0755 /usr/local/bin/marimohub-ssh /usr/local/bin/marimohub-ssh-shell

EXPOSE 2222
USER appuser
WORKDIR /workspace
