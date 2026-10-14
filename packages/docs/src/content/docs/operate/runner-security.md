---
title: Runner security
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

## Docker Policy

Every command in a runner container, an agent's command and a Page build alike, is started by one `docker run` call with:

- `--user 10001:10001`: the command is not root
- `--cap-drop ALL` and `no-new-privileges`: no capabilities, and none to gain
- `--network none`
- a read-only root filesystem
- writable `/workspace`, which is the home directory, and tmpfs for `/tmp` and `/var/tmp` owned by the same user
- CPU, memory, and pid limits
- Docker's default seccomp profile
- bounded wall-clock and idle timeouts
- bounded stdout and stderr previews

None of these is a setting. The runner image should contain approved runtimes and artifact helpers at build time. Agents should not install packages dynamically in production.

## The Runner's User

The user id and the group id are both `10001`, the constants `RUNNER_USER_ID` and `RUNNER_GROUP_ID` in `packages/tool-execution/src/docker-workspace-command-runner.ts`. Both runner images create this user as `catalyst-runner` with the home directory `/workspace` and start as it, so a container started by hand is not root either. The ids on `docker run` are numbers, so a runner image of an older release, which has no such user, still runs commands as `10001`.

The worker is root in its own container. Before each command it gives the directory it filled to `10001:10001`, and afterwards reads and removes the files as before. A link in the directory is given away itself and is not followed. If the directory cannot be given away, the command does not start and fails with `WORKSPACE_COMMAND_SPAWN_FAILED`, or the Page build with "could not be started". It never starts as root instead.

What an operator must know:

- **Ownership on the host.** Files under `WORKSPACE_COMMAND_TEMP_ROOT` belong to user `10001` on the host while a command or build runs. Nobody has to create that user or prepare the directory. Do not give the id `10001` to a person or a service on the host.
- **The filesystem must keep ownership.** The directory has to lie on a filesystem where root may change the owner of a file: a local disk or a Docker volume. A network share that maps root to another user (NFS with `root_squash`) refuses it, and every command then fails as described above.
- **No user namespace.** The product does not turn on rootless Docker or user-namespace remapping. Without them, `10001` in the container is `10001` on the host, and root in the worker's container is root on the host. With either turned on, the worker and the runner must run under the same engine so both see the same mapping; this combination is not tested by a release.
- **The worker holds the Docker socket.** Whoever takes over the worker process can start any container and is as powerful as root on the host. The non-root user protects against a command in the runner, not against the worker.
- **A worker that is not root**, as on a developer's machine, cannot give files away. It runs commands as its own user and group instead, and no ownership changes. This case is not root either.

## Page Builds

With the module `apps` on, the same sandbox builds saved Pages. The build is the fixed command `catalyst-page-build` of the runner image, with a temporary directory of its own instead of a workspace. The files of a Page are written by an agent or a person and are not trusted, and the build tools that read them are third-party code. The sandbox is therefore the boundary: nothing of a Page is parsed or run outside it, and what the command writes is read back as untrusted data. See [Page Builds](/operate/deployment/#page-builds).

## Data Handling

Workspace file contents live in managed object storage and are referenced by manifest rows. Command audit events and operator telemetry must record minimized metadata only. Bounded stdout/stderr previews are command result data, not audit data, and should not be projected to users as final content.

Promoted artifacts are managed artifacts scoped to the conversation. Internal workspace files remain hidden from user download surfaces.

## Known Limits

Docker isolation is acceptable for the first dedicated VPS deployment. A command shares the host's kernel, filtered only by Docker's default seccomp profile, and runs without a user namespace. Higher-risk environments may require rootless Docker, user namespaces, an own seccomp profile, gVisor, Firecracker, or a managed sandbox service before enabling `workspace.exec` for sensitive workloads.

Network-enabled execution, package installation, and cross-conversation file libraries are not part of the v1 security model.
