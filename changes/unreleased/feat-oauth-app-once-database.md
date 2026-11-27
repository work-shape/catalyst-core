---
section: Database
---

- **Connections:** migration 0211 `connection_oauth_apps` creates the table
  `connection_oauth_apps` (one sealed OAuth app secret per instance and authorization server). It
  rewrites no row; a rollback leaves the table unused.
