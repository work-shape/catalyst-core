---
section: Database
---

- Migrations `0129_retire_namespaces`, `0130_permission_grants_scope_unique` and `0131_drop_grant_namespace` retire Namespaces in one step. Run them before app and worker startup.
  - Any Namespace deny stops `0129` before it changes anything, naming the instance, holder, action and prefix of each. On the release before, deny the same on the asset or the workspace, revoke the Namespace deny on Instance > Access, and migrate again.
  - Each Namespace allow becomes an allow, for the same holder and action, on every active asset the instance owns whose kind is the action's and whose name starts with the prefix: the assets it covers now. An asset created later under the prefix is not covered. A row the holder already has on such an asset, an allow or a deny, stays as it is. No workspace row is written, so nobody gains a right.
  - A personal key loses each scope limited to a prefix (`agent.write:kai-`); a key left with none covers nothing until it is replaced.
  - Every change writes the audit event an administrator's change writes (`permission.granted`, `permission.revoked`, `namespace.deleted`, `api_access.personal_key_narrowed`), with no actor, the reason `namespace_retired` and the correlation `migration:0129_retire_namespaces`.
  - `0129` drops the `namespaces` table with its build limits, `0130` builds the grant uniqueness without the prefix concurrently, and `0131` drops `permission_grants.namespace`. The previous release reads both, so roll back by restoring the backup taken before the migration.
