---
title: Execution Workspace Operations
description: Operate workspace command workers, runner images, cleanup, and artifact promotion.
---

Execution workspaces give agents a persistent conversation-scoped file area and a bounded command primitive. Operators should treat the feature as a worker-backed artifact pipeline, not as shell access inside the chat API.

## Runtime Roles

The production-shaped deployment has these roles:

- chat API: validates tool calls, enqueues workspace commands, exposes promoted artifacts, and never runs shell commands
- workspace command worker: claims command rows, hydrates workspace files, starts a short-lived runner, syncs changed files, and records terminal status
- runner container: executes the agent-authored command with no platform secrets and no network by default
- object storage: stores workspace file bytes and promoted artifact bytes
- Postgres: stores workspace, file manifest, command queue, leases, audit events, and managed artifact records

## Runner Image

The platform Dockerfile exposes a `workspace-command-runner` target for the `executionWorkspaces.runner.image` container. It includes `/bin/bash`, Node, Python artifact libraries, LibreOffice, Poppler, fonts, ImageMagick, and common shell utilities so `workspace.exec` can run ordinary script-first DOCX, XLSX, PPTX, PDF, and image workflows without package installs at command time.

The image target intentionally does not copy the chat API build or deployment secrets. The `workspace-command-worker` target remains the trusted control process image with Docker CLI access; it starts short-lived runner containers from the configured runner image.

Capability-owned Catalyst helper CLIs such as `docx_render`, `xlsx_scan_errors`, `pptx_render`, `pdf_inspect`, and `promote_artifact` are packaged outside the OSS platform. Deployments that enable those premium helpers should layer the capabilities helper package onto the platform runner image and publish that layered image tag through `EXECUTION_WORKSPACE_RUNNER_IMAGE`.

## Operational Signals

Workspace command lifecycle audit events use these event types:

- `workspace_command.queued`
- `workspace_command.running`
- `workspace_command.completed`
- `workspace_command.failed`
- `workspace_command.timed_out`
- `workspace_command.cancelled`
- `workspace_command.recovered_stale`

Audit metadata includes command id, workspace id, conversation id, timeout, attempts, counts, error code/category, and duration where available. It must not include command text, stdout, stderr, file contents, or object-store credentials.

The worker also emits operator telemetry logs with `workspace_command.*` event types. These logs include active queued/running/cancelling counts, terminal status, timeout categories, and temp cleanup counts. Use these logs for queue pressure and failure-rate alerting.

## Cleanup

Conversation deletion and retention expiration call execution workspace cleanup before the conversation is marked unavailable. Cleanup deletes internal workspace object bytes, removes workspace file manifests, removes workspace command rows, and marks the workspace deleted.

A periodic cleanup job also scans for active workspace metadata attached to already deleted or retention-expired conversations. This catches interrupted delete/retention paths.

The workspace command worker periodically removes orphaned local temp directories with the `catalyst-workspace-` prefix after the configured max age. The durable source of truth is object storage plus the workspace manifest, not temp directories or runner containers.

## Promoted Artifacts

Users should only receive promoted artifacts. Internal workspace files and logs are visible to agent tools for debugging and follow-up commands, but they are not projected as user-downloadable artifacts until `workspace.promote_artifact` or an expected promoted output creates a managed artifact.

## Incident Checks

For command failures:

- check `workspace_command.failed` and `workspace_command.timed_out` audit events
- check worker logs for queue counts and stale recovery
- verify the workspace command worker is running
- verify the runner image tag matches the release
- verify object storage root or credentials are writable by the worker
- verify Docker can start a no-network runner container

Do not inspect or paste raw workspace files, command strings, stdout, or stderr into support tickets unless the customer has approved that specific data access path.
