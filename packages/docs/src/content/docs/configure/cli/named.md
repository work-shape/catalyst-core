---
title: Workflows, checks and lists
description: Call Workflow, guardrail, Data Store and instance operations by name.
---

## Workflows, checks and lists

These commands call the existing API operations with the same key and checks. They print readable YAML by default; add `--json` for JSON. Paginated lists read every page and print the combined items.

```sh
catalyst workflow test month-end --from test-input.json  # {"input":{"month":"2026-10"}}
catalyst workflow runs month-end
catalyst workflow run <run-id>
catalyst workflow steps <run-id>
catalyst workflow cancel <run-id>
catalyst guardrail hits no-iban
catalyst knowledge-base check accounts
catalyst data-store describe reporting
catalyst data-store used-by reporting
catalyst app actions offers
catalyst keys list
catalyst instance workspaces
```

`workflow test` tests the saved draft and simulates changing steps. Its optional `--from <file|->` reads the JSON request body (`{"input": {...}}`); without it, the body is `{}`. It starts a run and returns its current state; use `run` and `steps` to read progress. `cancel` cancels the run you name. These commands do not start a live Workflow.

`app actions` without a name lists actions of the published Apps you may read; with a name it reads that App's draft if you may write it, otherwise its published revision. `keys list` lists your own key metadata, never secrets. `instance workspaces` uses `instance.workspaces.list`: the Shared Workspaces that agents, Knowledge Bases and Connections can be made available in, requiring `config_assets:write` and, on the whole instance, `agent.write`, `knowledge_base.write` or `connection.write`. It is not the list of your workspace memberships.

`guardrail hits` preserves the API's counts and `hasMore`; `data-store used-by` preserves hidden counts and `truncated`, and `app actions` preserves `truncated`. These bounded responses are not paginated lists. All commands accept `--instance` and `--dir` as above, and use the same exit codes, including 3 for a held change.
