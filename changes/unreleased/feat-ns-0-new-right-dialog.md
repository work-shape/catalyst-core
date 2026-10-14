---
section: Changed
---

- **The New right dialog offers no Namespace, and Connection rights no workspace:** Instance >
  Access offers a new right in a shared workspace (chosen first where the kind can be owned by
  one), on one asset, or on the whole instance, each only where the right can be written there,
  and asks for no place when there is one. Today every kind has one place, one asset. Rights in
  a Namespace that exist stay listed and revocable, and `permissions.grant` still writes them,
  until the Namespace is retired. `connection.read` and `connection.use` at workspace scope are
  refused with `422` and the reason `invalid_scope`: "'connection.use' cannot be granted at the
  scope kind 'workspace'". **Operators:** rows already written there stay and are read as
  before, and the Access page lists them under the workspace's name; revoke them there.
  **Rollback:** an earlier release writes them again.
