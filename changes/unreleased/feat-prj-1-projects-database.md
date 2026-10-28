---
section: Database
---

- Migration `0170_projects` adds the table `projects` (a project asset's audience and creator) and the nullable column `conversations.project_id`, with its key and check added `NOT VALID`; no row is rewritten. `0171_project_conversations_index` builds the index of a project's conversations concurrently, and `0172_projects_validate` validates the key and the check in a transaction of its own, so reads and writes pass during the scan.
