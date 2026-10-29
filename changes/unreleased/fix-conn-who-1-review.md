---
section: Fixed
---

- **Connections:** "Who may use it" no longer counts what a reader may not see. A reader who manages no users gets only the built-in roles with their verbs, with no count of custom roles, people or groups. Service principals are neither named nor counted for a reader who does not see them. Naming people, groups and custom roles needs `users.manage` and a credential with the `user_admin:read` scope.
- **API:** `connections.access` returns `holdersShown` in place of `hidden`.
