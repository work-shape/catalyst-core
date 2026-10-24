---
section: Changed
---

- **Access:** "Manage service principals" (`service_principals.manage`) can be given to a person on the whole instance on the Access page, by whoever holds it. Before, a person got it only through a role. Admins and superadmins still hold it by default.
- **Mail:** Who may mail the members of any Shared Workspace (`mail.send` with a `{ workspace }` recipient) is decided by "Manage users" (`users.manage`) on the whole instance instead of the admin or superadmin role. A custom role or a key that carries it counts, and a deny takes it away. Everybody else still mails only the Shared Workspaces they are a member of, and nobody mails a Personal Workspace.
- **Data Stores:** `data_stores.get` answers what the database server leaves open around a store (`conditions`) only to a reader with `system.view`. Everybody else gets an empty list, as the page already showed them.
- **Access:** The "New right" dialog offers the instance's own kinds (Users, Jobs, System, Usage, Service principals) to whoever holds their rights. Before, it listed only kinds with assets, plus Workspaces and Roles, so rights held on the whole instance could not be given there.
