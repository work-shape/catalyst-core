---
title: Local Execution Workspaces
description: Develop and test execution workspaces locally.
---

Use the repository root as the pnpm workspace root when developing execution workspaces.

## Requirements

- pnpm 10.29.3
- Docker for production-shaped worker smoke tests
- Python 3 for workspace command tests
- the runner image dependencies when testing Office/PDF helpers locally

## Useful Commands

From the workspace root:

```bash
corepack pnpm@10.29.3 --dir platform typecheck
corepack pnpm@10.29.3 --dir platform test -- tests/workspace-command-runner.test.ts
corepack pnpm@10.29.3 --dir platform test -- tests/workspace-command-worker.test.ts
corepack pnpm@10.29.3 --dir platform test -- tests/workspace-tools.test.ts
CATALYST_WORKSPACE_RUNNER_IMAGE_SMOKE=1 corepack pnpm@10.29.3 --dir platform test -- tests/artifact-preview-runtime-wiring.test.ts
```

For the demo client:

```bash
pnpm dev:demo
```

For a deployment-owned local instance:

```bash
pnpm dev:<client>
```

## Local Runner Modes

The local runner adapter executes commands in a disposable temp directory and syncs changed files through the same manifest and byte-store contract. It is for tests and development only.

The Docker runner adapter is the production-shaped path. It starts a short-lived runner container per command, mounts `/workspace`, applies no-network defaults, and removes timed-out or cancelled containers.

## Debugging

When a command fails, inspect:

- the command status and error category
- bounded stdout/stderr previews in the tool result
- `workspace_command.*` audit events
- worker telemetry logs for queue counts and stale recovery
- object root and temp root paths

Do not paste workspace object keys, raw command text, stdout/stderr, or file contents into shared logs.
