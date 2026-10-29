---
section: Database
---

- Migration `0177_project_idle_notice` adds the nullable column `projects.idle_notice_at`, when the retention job gave notice of an idle project. No default, so no row is rewritten.
