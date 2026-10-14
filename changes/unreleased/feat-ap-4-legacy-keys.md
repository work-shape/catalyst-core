---
section: Changed
---

- **A person's or a service principal's own rights are grant rows (AP-4):** the nine legacy
  permission keys in the lists of users and service principals become instance-wide rows of
  `permission_grants`, one per action a key stands for (`config_assets.write` is `agent.write`,
  `agent.delete`, `skill.write` and `skill.delete`), an allow for `key` and a deny for `!key`,
  written with `grantedBy` `legacy_permission_list`. The evaluator no longer reads the columns
  `permissions`, and nothing writes them. The Users and API access screens show and save the
  same lists, now as rows: a saved list rewrites only the keys it changes, and the new rows name
  who saved them. A list entry that is no key is refused with `422` "'…' is not a permission".
  **Instance > Access** no longer lists the instance-wide rows of a user or a service principal,
  and revoking one there is refused with `invalid_scope` "An instance-wide right is changed on
  the page of the user or the service principal". `permissions.effective` names such an entry
  with the source `grant`; the source `legacy` is gone from the contract, and the Check tab
  calls such a right "Given right". An API key created without scopes is stored with `["*"]`.
  An API key's scopes still cap its service principal: a key holds a principal's instance-wide
  right only when one of its scopes carries the legacy key behind it, one key per scope as a
  request read it before (`governance:read` is `usage.view`). No user, service principal or API
  key gains or loses a right.
