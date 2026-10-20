---
section: Changed
---

- Namespaces are retired (NS-RETIRE). Instance > Access has no Namespaces tab and Studio shows no Namespace on an asset. The `namespaces.*` operations, the `namespaces` of `platform.context`, the `namespace` of an asset and of a grant, and `namespace:` in a working copy's `catalyst.yaml` are gone. A right is given on the instance, a workspace or one asset; build limits are a workspace's (`workspaces.limits.list`, `workspaces.limits.update`). A grant with `scopeKind: "namespace"` is refused with `VALIDATION_FAILED`.
- A personal API key's scope names an action, a workspace by its id or one asset in it: `agent.write`, `agent.write:<workspace>`, `agent.write:<workspace>/<name>`. A scope that names a workspace the instance does not have is refused at issuance (`unknown_workspace`); one the person holds no right in is refused naming the action and the workspace. Settings > API keys picks the workspace from a list.
- An `assets.sync` batch other than a release names its workspace (`workspaceId`), otherwise it is refused: only a release writes the instance's own assets. A working copy without `workspace:` pushes a release only.
- A CLI of an earlier 0.8.0 release candidate reads `namespaces` from `platform.context` and refuses this server's answer. Update the CLI with the server.
- The demo seed puts the held skill calls and Elif's build limits on the workspace `Personalwesen / HR` instead of the prefix `hr-`.
- A `workspaceId` with a NUL byte on an asset route is refused with `VALIDATION_FAILED`, as a name is, instead of failing in the database.
