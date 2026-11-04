---
section: Added
---

- **Custom roles reach people:** A person's page under Users has "More roles" ("Weitere Rollen"), a multi-select of the custom roles beside the built-in role, and a custom role's page under Access > Roles lists "People" ("Personen") who hold it, with Add person and a way to take it from each. Both go through `users.update` and its rules: the giver holds every right the role carries, nobody gives themselves a role, and only a Superadmin gives a role that carries a right only a Superadmin hands out. The holder gets the role's rights in every check and in their effective rights at once.
- **Audit:** Giving and taking a custom role are the events `user.role_assigned` and `user.role_removed`, with the person and the role id only.
