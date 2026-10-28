---
section: Database
---

- Migration `0174_skill_draft_file_set` adds the nullable `file_set_id` column to `agent_change_proposal_revisions`: the folder a skill draft revision holds. Existing rows keep `NULL`; no row is rewritten.
