---
title: Local Execution Workspaces
description: Test execution workspaces from the repository and see what an instance needs to run them.
---

Execution workspaces give an agent a file area per conversation and a bounded command tool. The code is in the open repository: the tools `workspace.exec`, `workspace.apply_patch`, `workspace.import_files`, `workspace.list_files`, `workspace.read_file`, `workspace.preview_images` and `workspace.promote_artifact`, the command queue, the worker and the runner image.

The demo client does not enable execution workspaces. From the repository alone you can run the tests of the feature. To use it in a chat, a client assembly has to enable it and start a worker, as described under [What An Instance Needs](#what-an-instance-needs).

## Requirements

- Node.js and pnpm in the version the repository's `packageManager` field names
- a disposable Postgres database for the tests, in the variable `POSTGRES_STORE_TEST_DATABASE_URL`; its role needs `CREATEDB`
- Python 3 on the path, which the command tests call
- Docker, for the runner image and the Docker sandbox

## Run The Tests

From the repository root, after `pnpm install` and `pnpm build`:

```bash
export POSTGRES_STORE_TEST_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/catalyst_test
pnpm exec vitest run tests/workspace-command-runner.test.ts
pnpm exec vitest run tests/workspace-command-worker.test.ts
pnpm exec vitest run tests/workspace-tools.test.ts
```

One more test builds the runner image and runs a script in it. It needs Docker and only does so when asked:

```bash
CATALYST_WORKSPACE_RUNNER_IMAGE_SMOKE=1 pnpm exec vitest run tests/artifact-preview-runtime-wiring.test.ts
```

## What An Instance Needs

A client assembly runs execution workspaces when all of these are in place:

- `executionWorkspaces.enabled: true` in release config
- `infrastructure.objectStorage.workspaces`: a `filesystem` root that the API and the workers share
- `infrastructure.sandbox`: `docker` with a runner image, or `local`
- a worker process beside the API, started with `runClientInstanceWorkspaceCommandWorker` from `@vivd-catalyst/client-assembly`
- the workspace tools enabled under `tools` and named in the `toolNames` of the agents that use them

Startup stops when execution workspaces are enabled without the object storage or the sandbox. [Release Config](/configure/release-config/#infrastructure) describes both settings, and [Execution Workspace Operations](/operate/execution-workspaces/) the roles in a deployment.

## Sandbox Providers

The `local` sandbox executes commands in a temporary directory on the host. It is accepted only for a client instance whose environment is `development`, and it is for development and tests.

The `docker` sandbox is the production-shaped path. It starts a short-lived runner container per command, mounts `/workspace`, applies no-network defaults, and removes timed-out or cancelled containers. The runner image is the target `workspace-command-runner` of `docker/vivd-client.Dockerfile`.

## Debugging

When a command fails, inspect:

- the command status and error category
- bounded stdout/stderr previews in the tool result
- `workspace_command.*` audit events
- worker telemetry logs for queue counts and stale recovery
- object root and temp root paths

Do not paste workspace object keys, raw command text, stdout/stderr, or file contents into shared logs.
