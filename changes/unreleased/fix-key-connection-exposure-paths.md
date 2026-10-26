---
section: Fixed
---

- A personal API key no longer reaches a Connection's data through a surface other than an operation exposed to `outside`. `apps.try_action` refuses an API key or a service principal (`user_only`). A test run of a Workflow draft started with a key carries the key into its steps: a Connection operation, whether an operation step or an agent step's tool, then also needs exposure `outside` and the scope `connection.use` on the key, and is refused with the same reasons as the key's direct call (`connection_exposure:outside`, `outside_key_scope`); a revoked or expired key stops the run (`tester_key_unusable`). A draft without a Connection step test-runs with a key as before.
- An API key reads step outputs, code step logs and loop item labels of a Workflow run only with `workflow.read_run_data` or in a test run it started itself, and a run's result only with that right or for a run it started itself (`workflows.list_step_runs`, `workflows.get_run`, `workflows.list_runs`, `workflows.cancel_run`); `workflows.download_dataset` without that right likewise needs the run to be the key's own. A run records the key it was started with. A person signed in to the app reads what they read before.
- `connections.source_folders` refuses an API key (`connection_exposure:outside`): folder names are data of the outside system, and nothing exposes them to `outside`.
