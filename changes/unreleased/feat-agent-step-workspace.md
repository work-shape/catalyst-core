---
section: Added
---

- A Workflow agent step can opt into a workspace with `workspace: true`. Its agent gets `workspace.exec`, `workspace.read_file`, `workspace.write_file`, `workspace.edit_file` and `workspace.list_files` in an Execution Workspace of its own thread: the same sandbox without network, and the same per-command and per-workspace limits as a chat agent's commands. The input is written in before the first turn as `in/input.json`, each dataset as a JSON Lines file, each run file under `in/files/` and each text over 2,000 characters as a `.txt` file; the task message names those files by path instead of holding their values.
- Such a step may take datasets in its input and declare `{ "type": "dataset", "row": … }` fields in its `outputSchema`. The agent answers each with `{ "path": "out/<name>.jsonl" }`; the engine checks every line against the row schema and stores it as the step's dataset, as it does for a code step.
- The workspace of a Workflow agent step's thread is removed by the Execution Workspace cleanup once its run's values are pruned or the run is deleted. A step with a workspace fails with `runner_unavailable` on an instance without Execution Workspaces, a sandbox or the five workspace tools enabled.
- The five workspace tools may now be called by a run whose actor is a service principal, as they reach only the workspace of the run's own thread.
