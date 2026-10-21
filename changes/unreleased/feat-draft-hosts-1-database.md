---
section: Database
---

- **Apps:** Migration `0138_draft_host_allowances` adds the table `draft_host_allowances`: one row per person, App or Page, and outside host allowed for that person's preview of a draft. Its rows go with their App, Page or person. Apply it before starting the new API. It preserves compatibility with the previous release and moves no data. Rolling back the application leaves the table unread; remove it only through a later committed migration.
