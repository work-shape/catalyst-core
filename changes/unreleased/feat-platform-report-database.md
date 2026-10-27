---
section: Database
---

- Migration `0166_platform_reports` adds `platform_reports`: one row per platform problem report, with the run, the person and the error code, never the note. It holds the limits of one report per run and person and five an hour; rows go with their person, and a daily job removes them after 90 days.
