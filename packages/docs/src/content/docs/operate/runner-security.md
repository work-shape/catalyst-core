---
title: Runner Security Assumptions
description: Security boundary and assumptions for execution workspace runners.
---

`workspace.exec` is a high-risk capability. The product boundary is that agent-authored commands run outside the chat API, inside a short-lived runner with no broad secrets and no network by default.

## Required Boundaries

Runner containers must not receive:

- platform database credentials
- model provider keys
- customer API tokens
- object-store credentials
- the Docker socket
- internal network access
- outbound internet access

The workspace command worker is the trusted control process. It can read and write the exact workspace objects required for a command, then starts the sandboxed runner with only the mounted workspace and bounded environment variables.

## Default Docker Policy

The Docker runner should use:

- `--network none`
- read-only root filesystem where practical
- writable `/workspace`
- tmpfs for `/tmp` and `/var/tmp`
- CPU, memory, and pid limits
- `--cap-drop ALL`
- `no-new-privileges`
- bounded wall-clock and idle timeouts
- bounded stdout and stderr previews

The runner image should contain approved runtimes and artifact helpers at build time. Agents should not install packages dynamically in production.

## Data Handling

Workspace file contents live in managed object storage and are referenced by manifest rows. Command audit events and operator telemetry must record minimized metadata only. Bounded stdout/stderr previews are command result data, not audit data, and should not be projected to users as final content.

Promoted artifacts are managed artifacts scoped to the conversation. Internal workspace files remain hidden from user download surfaces.

## Known Limits

Docker isolation is acceptable for the first dedicated VPS deployment. Higher-risk environments may require rootless Docker, user namespaces, gVisor, Firecracker, or a managed sandbox service before enabling `workspace.exec` for sensitive workloads.

Network-enabled execution, package installation, and cross-conversation file libraries are not part of the v1 security model.
