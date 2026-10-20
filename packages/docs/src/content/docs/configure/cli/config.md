---
title: Config working copies
description: Synchronize a local working copy with an instance or workspace.
---

## What it does

The `config` commands synchronize agents and skills between a folder and an instance. [Config assets](/configure/config-assets/) describes the working copy, the commands and what a push does.

```sh
catalyst config pull
catalyst config diff
catalyst config validate
catalyst config push
```

A push of a changed agent writes the agent's draft and prints "draft revision n"; the live revision stays until somebody publishes the draft. `catalyst config push --publish` publishes each draft the push wrote, which needs a personal key with the publish right, `config_assets:publish`. A service principal's key, such as an operated instance's release key, writes drafts and publishes none. [Agents: a push writes a draft](/configure/config-assets/#agents-a-push-writes-a-draft) has the rest, and the one pull a working copy of an earlier CLI needs.

A working copy can belong to one Shared Workspace: then the agents and skills it pushes are the workspace's own, and a pull reads only what the workspace owns. Bind an empty working copy once with its first pull:

```sh
catalyst config pull --workspace <workspace-id>
```

The pull writes `workspace: <workspace-id>` beside the instance's `url` in `catalyst.yaml`, and every later command of that working copy names the workspace. A working copy is bound once: one bound to another workspace and one that already pulled the instance's own assets are refused, so pull another workspace into a directory of its own. Its `push` is never a release and never changes the instance's default agent, which only an agent of the instance can be; an agent it creates starts hidden until an instance admin offers it, and a guardrail it creates belongs to the workspace as well. A workspace's agent may name the workspace's skills and the instance's skills you may read; no agent outside the workspace may name the workspace's skills.
