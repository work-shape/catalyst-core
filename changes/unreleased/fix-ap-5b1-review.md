---
section: Changed
---

- **Rights:** A deny held through a role or a group, `user` and `admin` included, no longer applies to a superadmin; a deny written on the superadmin still does, except on `users.manage`. Before, a deny of `roles.edit_built_in` in `user` took the right from every superadmin at once.
- **Rights:** "Reset to default" and applying a pending right of a built-in role are checked like an edit: the caller must hold every right the change gives back, and every right a deny it lifts refused.
