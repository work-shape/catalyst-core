---
section: Database
---

- Migration `0163_preview_captures` adds `preview_captures`: one row per picture a run asked of a person's preview, with where the request stands and the artifact of the picture, never the picture. Rows go with their conversation, their person or their file set, and the hourly preview-report job removes them after a day.
