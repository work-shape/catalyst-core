---
section: Fixed
---

- A personal API key no longer reaches a Connection's data through a surface other than an operation exposed to `outside`. `apps.try_action` refuses an API key or a service principal (`user_only`).
- A test run of a Workflow draft started with a key carries the key into its steps, with the key's scopes. Each step's call then needs what the key's own call would need:
  - A Connection operation, from an operation step or as an agent step's tool, needs exposure `outside` and `connection.use` on the key. It is refused with the same reasons as the key's direct call (`connection_exposure:outside`, `outside_key_scope`).
  - A Data Store or Knowledge Base step needs the operation scope of its call. A key never carries `data_store_rows:*`, so these steps are refused (`outside_key_scope`).
  - A revoked or expired key stops the run (`tester_key_unusable`).
  - A draft without such a step test-runs with a key as before.
- A call that waited for an approval runs with the scopes of the key it was made for, and is not run once that key is revoked or expired.
- For runs it did not start, an API key reads step outputs, code step logs, loop item labels, run labels, run keys and the result only with `workflow.read_run_data`. This applies to `workflows.list_step_runs`, `workflows.get_run`, `workflows.list_runs`, `workflows.cancel_run`, and to the run that `workflows.start` or `workflows.test` answers for a key another run already holds.
- Without that right, a key may not list runs by `keyPrefix`, and `workflows.download_dataset` needs the run to be the key's own. A run records the key it was started with. A person signed in to the app reads what they read before.
- `connections.source_folders`, `knowledge_bases.source_items` and `knowledge_bases.locate` refuse an API key (`connection_exposure:outside`): the names, paths and links of a source's folders and items belong to the outside system, and nothing exposes them to `outside`.
