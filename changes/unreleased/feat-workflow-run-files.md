---
section: Added
---

- Files of a Workflow run: a capability keeps a file in the run it serves (`runFiles.create`), and step data names it by `{ $file, name, mimeType, bytes }`. Each is a Managed File owned by the run, its bytes below the run's prefix in the files store, capped at 25 MiB a file and 200 MiB a run, and recorded as a `workflow_run.file_kept` audit event with size, digest and type, never its name. Every step refuses a reference to a file that is not its run's, and a definition may not name one. An agent step gets a copy of each file its input names as an attachment of its task, prepared before its first turn. The files and the copies go when the run's values are pruned.
