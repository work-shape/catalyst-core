---
section: Added
---

- Files of a Workflow run: a capability keeps a file in the run it serves (`runFiles.create`), and step data names it by `{ $file, name, mimeType, bytes }`. Each is a Managed File owned by the run, its bytes below the run's prefix in the files store, capped at 25 MiB a file and 200 MiB a run, and recorded as a `workflow_run.file_kept` audit event with size, digest and type, never its name. Every step refuses a reference to a file that is not its run's, and a definition may not name one. An agent step gets a copy of each file its input names as an attachment of its task, prepared before its first turn; a file still being prepared after ten minutes fails the run with `files_unavailable`. The files and the copies go when the run's values are pruned.
- A tool may declare `auth: "principal"` to serve a run whose principal is a service principal, such as a published Workflow's agent step; a tool that declares none still serves a person only.
- The audit events `outside_form.requested` and `outside_form.mail_failed` are registered, with the recipient's domain and the form's field and page counts.
- `resolveInstanceModules` takes `shippedOnly`, for a process that serves part of the instance: a module switched on that its build does not ship is left out instead of refused.
