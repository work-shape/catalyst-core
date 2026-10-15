---
section: Changed
---

- **No escalation through service principals (RIGHTS-1a):** a person gives or lends a right
  only where their own call holds it, with the scopes of a personal key counted. Making a
  Workflow revision live, the newest or an earlier one, asks `workflow.publish` and every right
  of the service principal it runs as. The superadmin role and `api_access.manage` no longer
  stand in for that, so an administrator publishes a Workflow whose principal holds what she
  holds. A test run is unchanged. A Workflow whose principal holds `config_assets.release` is
  published by nobody. A refusal names the first missing right, and the asset only where the
  caller may read it.
- **`service_principals.manage`:** a new right, held by administrators and superadmins through
  their role. It lists and creates service principals, gives and takes their rights, and
  enables and disables them, each gift and each enabling under the rule above. Issuing a key
  needs `api_access.manage` and every right of the principal; revoking one needs
  `api_access.manage` only. Only a superadmin gives a principal `config_assets.release`. The
  API access page shows principals to holders of the new right and keys to holders of
  `api_access.manage`.
- **`PlatformContext.instanceActions`:** `platform.context.get` names the rights the caller
  holds over the instance itself, today `service_principals.manage`.
