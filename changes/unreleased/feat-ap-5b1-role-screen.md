---
section: Added
---

- **Roles screen:** Settings > Instance > Access has a Roles tab. It lists User, Admin and Superadmin, then the custom roles; a new role copies the rights of another, and a custom role is renamed and deleted from its row. A role's page shows its rights by area in the sentences of the Rights tab and edits them, resets User and Admin to their default, and decides each right a release added to or took from an edited default (Add / Leave out, Remove / Keep). Superadmin is read-only. The Access page shows a notice while a decision is open.
- **Rights:** A new instance right, `roles.edit_built_in` ("Edit the built-in roles User and Admin"), edits, resets and decides for `user` and `admin` (amends ADR-0028, point 1). Superadmins hold it by default and can give it to a person or a role. Its holder still adds only rights they hold; rights only a superadmin hands out stay with superadmins; `superadmin` is never written; the last superadmin stays. A refusal of such an edit now names `roles.edit_built_in` instead of the operation.
