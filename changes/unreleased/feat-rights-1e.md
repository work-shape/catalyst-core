---
section: Changed
---

- **Access:** Deleting a user and retrying a background job are rights: "Delete users" (`users.delete`) and "Retry jobs" (`jobs.retry`). Superadmins hold both by default and can give them to a person or a role at instance scope. Admins do not hold them. Deleting still needs "Manage users" and every right the account holds; only a superadmin deletes a superadmin, and nobody deletes their own account. A refusal names the missing right. The Users and Jobs pages offer delete and retry by the right, not by the role. A test checks every superadmin role check in the packages against the named list in the access spec.
