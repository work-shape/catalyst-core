---
title: Operate code execution
description: Operate workspace command workers, runner images, cleanup, and artifact promotion.
---

Execution workspaces give agents a persistent conversation-scoped file area and a bounded command primitive. Operators should treat the feature as a worker-backed artifact pipeline, not as shell access inside the chat API.

## Runtime Roles

The production-shaped deployment has these roles:

- chat API: validates tool calls, enqueues workspace commands, exposes promoted artifacts, and never runs shell commands
- workspace command worker: runs the job of each command on the job executor, hydrates workspace files, starts a short-lived runner, syncs changed files, and records terminal status
- runner container: executes the agent-authored command with no platform secrets and no network by default
- object storage: stores workspace file bytes and promoted artifact bytes
- Postgres: stores workspace, file manifest, command queue, leases, audit events, and managed artifact records

Commands wait in the durable Postgres queue until worker capacity is available. Each command is a job of the kind `workspace.command`; one workspace runs one command at a time, in the order they were queued. A command runs once: when its worker dies, the command fails with the category `worker_lost` after its lease of two minutes and is not started again; until then the later commands of that workspace wait. `executionWorkspaces.worker.concurrency` is the deployment control for simultaneous runner containers; queued commands are not rejected through separate per-user or global admission caps. Size worker concurrency for the host, and use queue wait time as the signal to add execution capacity.

## Source file uploads

The conversation upload request can name the agent selected for the next turn with the
`agentName` query field. The server checks that the caller may use that agent in the
conversation's workspace. When execution workspaces are enabled and the agent holds both
`workspace.import_files` and `workspace.exec`, every nonempty file is accepted within
`executionWorkspaces.sourceFiles.maxFileBytes` (25 MiB by default). Word temporary owner
files (`~$…`) are refused. Without both tools, or when the request omits the agent, the
existing file allowlist applies. Changing agents later leaves the next run's tool offer
in control of what that run can do.

Specialized attachment readers retain the formats they read. Other files are stored as
workspace sources, importable byte for byte. A bounded inspection of the first 8192 bytes
adds a type description to the source manifest; filenames and browser media types do not
establish that description. Container subtypes that cannot be established from the prefix
are described as the container (for example ZIP or OLE), and unrecognized bytes as unknown
binary data. Inspection does not unpack archives or run converters in the API.

Source files use the existing conversation authorization, retention, deletion and backup
rules. Their bytes remain in the instance's workspace object store; this change introduces
no external processing or region change. Audit and request logs contain no filename, mail
address, subject or file content.

## Runner Image

The platform Dockerfile exposes a `workspace-command-runner` target for the `infrastructure.sandbox.image` container. It includes `/bin/bash`, Node, Python artifact libraries, LibreOffice, Poppler, fonts, ImageMagick, and common shell utilities so `workspace.exec` can run ordinary script-first DOCX, XLSX, PPTX, PDF, and image workflows without package installs at command time.

The image target intentionally does not copy the chat API build or deployment secrets. The `workspace-command-worker` target remains the trusted control process image with Docker CLI access; it starts short-lived runner containers from the configured runner image.

Capability-owned Catalyst helper CLIs such as `docx_render`, `xlsx_scan_errors`, `pptx_render`, `pdf_inspect`, and `promote_artifact` are part of the paid capabilities and not in the open repository. Deployments that license those helpers layer the capabilities helper package onto the platform runner image and publish that layered image tag through `EXECUTION_WORKSPACE_RUNNER_IMAGE`.

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

The worker keeps a hydrated local workspace directory after each command and reuses it until `executionWorkspaces.cleanup.hydratedWorkspaceIdleTtlMs` expires. Set the value to `0` to disable reuse. Before every command, the worker reconciles the directory with the durable workspace manifest, and after every command it syncs changed files back to durable storage. Runner containers remain short-lived.

Empty directories remain available while that warm local copy is reused. The durable manifest stores files, so empty directories do not survive cache eviction, worker restart, or execution on a different worker.

The same periodic cleanup removes expired or orphaned directories with the `catalyst-workspace-` prefix. The durable source of truth is object storage plus the workspace manifest, not hydrated directories or runner containers.

## Skill folders

A command of an agent run mounts the folder of each skill the run may read at `/skills/<name>/`, one read-only bind each (`--mount type=bind,source=<folder>,target=/skills/<name>,readonly`). The command keeps `--network none` and every other limit. The skills are fixed when the command is queued, as the column `skill_mounts` of `workspace_commands` records them: name, revision and version, never content.

The worker reads each folder from the instance's database and `files` store, the same read as `assets.get files=true`, and keeps it below `WORKSPACE_COMMAND_TEMP_ROOT` in `catalyst-skill-folders/`, one folder per instance and skill revision, never inside a workspace. A folder is filled in a temporary folder, every file checked against its hash, files `0444` and folders `0555`, and renamed into place whole. Before each use the worker checks it again against the hashes it recorded; a folder that changed on the disk is filled again, never mounted. The worker only copies the bytes: it never runs, imports or parses a skill's file. The same periodic cleanup removes the folders no command used for `executionWorkspaces.cleanup.hydratedWorkspaceIdleTtlMs`. Skill bytes stay in the instance: in its object storage and, while cached, on its worker's disk.

A folder that cannot be read or does not match its hashes fails the command with `WORKSPACE_SKILL_MOUNT_FAILED`, the reason `skill_mount_failed` and the skill's name, and nothing runs. The command scan reads `/workspace` alone, so nothing below `/skills` becomes a workspace file or an artifact. A Workflow's code step mounts no skill.

The `local` sandbox, for development only, has no mounts: it copies the folders to `<execution directory>/skills/<name>`, beside the workspace (`$WORKSPACE_DIR/../skills/<name>`), and does not keep them read-only.

## Promoted Artifacts

Users should only receive promoted artifacts. Internal workspace files and logs are visible to agent tools for debugging and follow-up commands, but they are not projected as user-downloadable artifacts until `workspace.promote_artifact` or an expected promoted output creates a managed artifact.

## Incident Checks

For command failures:

- check `workspace_command.failed` and `workspace_command.timed_out` audit events
- check worker logs for queue counts and for commands that failed as `worker_lost`
- verify the workspace command worker is running
- verify the runner image tag matches the release
- verify object storage root or credentials are writable by the worker
- verify Docker can start a no-network runner container

Do not inspect or paste raw workspace files, command strings, stdout, or stderr into support tickets unless the customer has approved that specific data access path.
