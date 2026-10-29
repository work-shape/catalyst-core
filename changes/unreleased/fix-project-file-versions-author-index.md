---
section: Database
---

- **Project files: author indexes (0176):** a person's deletion clears them as author of every project file version and project file by `client_instance_id` and the author column, which had no index, so each deletion scanned both tables whole. Migration `0176_project_file_author_indexes` adds the partial indexes `project_file_versions_by_user_idx` and `project_files_updated_by_idx`, built with `CREATE INDEX CONCURRENTLY` in a migration of its own so writes are not blocked. A test plans the deletion's two updates and asserts both use their index.
