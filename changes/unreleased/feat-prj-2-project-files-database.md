---
section: Database
---

- Migration `0173_project_files` adds the tables `project_files` (each file of a project as it is now) and `project_file_versions` (its kept versions), keyed to the project's asset with `on delete cascade`. Both are new and empty, so nothing is rewritten or validated.
