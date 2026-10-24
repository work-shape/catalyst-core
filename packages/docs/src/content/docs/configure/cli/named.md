---
title: Workflows, checks and lists
description: Call Workflow, guardrail, Data Store, instance and limit operations by name.
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
catalyst limits show
catalyst limits set --from limit.json  # {"level":"user","target":"<user id>","limits":{"monthly":50}}
```

`workflow test` tests the saved draft and simulates changing steps. Its optional `--from <file|->` reads the JSON request body (`{"input": {...}}`); without it, the body is `{}`. It starts a run and returns its current state; use `run` and `steps` to read progress. `cancel` cancels the run you name. These commands do not start a live Workflow.

`app actions` without a name lists actions of the published Apps you may read; with a name it reads that App's draft if you may write it, otherwise its published revision. `keys list` lists your own key metadata, never secrets. `instance workspaces` uses `instance.workspaces.list`: the Shared Workspaces that agents, Knowledge Bases and Connections can be made available in, requiring `config_assets:write` and, on the whole instance, `agent.write`, `knowledge_base.write` or `connection.write`. It is not the list of your workspace memberships.

`limits show` and `limits set` read and change the spend limits of Settings, Instance, Limits through `usage.limits.get` and `usage.limits.set`; both require `limits.manage`. `--from` reads one change: a `level` (`instance`, `workspace_default`, `workspace`, `user_default` or `user`), a `target` id for `workspace` and `user`, and `limits` with `daily` and `monthly` amounts in the currency of the rate card, or `null` to remove the value. An instance value above the release config's limit is refused. Each change is recorded in the audit log with its old and new value.

`guardrail hits` preserves the API's counts and `hasMore`; `data-store used-by` preserves hidden counts and `truncated`, and `app actions` preserves `truncated`. These bounded responses are not paginated lists. All commands accept `--instance` and `--dir` as above, and use the same exit codes, including 3 for a held change.

## Data Store review

The fields of a store's records that wait for a person, as "Prüfen" on the store's page shows them, and a decision on one:

```sh
catalyst data-store review list findings --table objekt
catalyst data-store review decide findings --table objekt --key 1402 --field kaufpreis \
  --action correct --value 150 --knowledge-base <kb-id> --document <document-id>
```

`review list` prints one page of candidates, each with its reason (`conflict`, `not_evidenced`, `confirmation_required` or `key_unresolved`) and the document and page it cites. It shows only candidates from Knowledge Bases you may use. Pass `--cursor` with the `nextCursor` it printed for the next page, and `--limit` for a page size other than 200.

`review decide` confirms a candidate (`confirm`), corrects it to `--value` (`correct`), or assigns a document whose object was not known to the object `--key` (`assign`). `--value` is read as JSON, so `150` is a number and `'"150"'` is text; anything that is not JSON is text. Where the candidates of a field disagree, name the document you decide on with `--knowledge-base` and `--document`; `assign` always names it. A confirmed or corrected value stays through later syncs. Both need `data_store.records` on the store, and a decision needs `knowledge_base.use` on the Knowledge Base of every candidate it settles. A decision is a person's: run it with your own key, not a service principal's. The audit event names the table, field and action, never the value.
