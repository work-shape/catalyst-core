---
section: Database
---

- **Data scope:** Add migration `0124_scope_assignments` for per-instance data scope assignments to people, groups and service accounts. It adds the assignment table and an empty-by-default identity-group column on users; existing users receive no scope assignment. Run migrations before starting the application and workers. Older binaries ignore assignments; rolling back the application removes data scope enforcement, so keep scoped stores unavailable to staff until the scoped release is restored.
