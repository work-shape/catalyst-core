---
section: Added
---

- **Workflows:** Code steps name an `entry` anywhere in their revision's source tree (`.py`, `.js`, `.mjs`). Shared modules, SQL, tests and unused files travel with the run through later publishes and deletion. The worker reads the revision's immutable file set, never git, and copies it through a byte-budgeted LRU disk cache into a read-only sandbox with the tree root as its working directory and on the language module path. Operator settings `workflows.source.*` bound files, tree, history and cache and are reported in platform context.

- **Workflow compatibility:** For one release, `file` remains an alias relative to `steps/` with its original writable scratch cwd and relative input.json/output.json IO; it also gets the tree read-only on its module path. Referenced legacy scripts under `steps/` that fit the previous 256 KiB per-script / 2 MiB aggregate bounds are still written to `config.files` for rollback. Current runs read that field only for revisions without a file set. Tree scripts read JSON on stdin or `WORKFLOW_INPUT_FILE` and print JSON or write `WORKFLOW_OUTPUT_FILE`, outside the read-only source root.
