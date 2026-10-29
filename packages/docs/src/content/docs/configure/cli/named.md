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
catalyst workflow start month-end --from input.json  # {"input":{"month":"2026-10"}}
catalyst guardrail hits no-iban
catalyst knowledge-base check accounts
catalyst data-store describe reporting
catalyst data-store used-by reporting
catalyst data-store rows reporting --table bookings --limit 20
catalyst data-store query reporting --sql "select id from bookings where id = 1"
catalyst data-store insert reporting --from rows.json  # {"table":"bookings","rows":[{"id":1}]}
catalyst knowledge-base query accounts --sql "select name from accounts"
catalyst app actions offers
catalyst keys list
catalyst instance workspaces
catalyst limits show
catalyst limits set --from limit.json  # {"level":"user","target":"<user id>","limits":{"monthly":50}}
```

`workflow test` tests the saved draft and simulates changing steps. Its optional `--from <file|->` reads the JSON request body (`{"input": {...}}`); without it, the body is `{}`. It starts a run and returns its current state; use `run` and `steps` to read progress. `cancel` cancels the run you name.

## Use commands

`workflow start`, `data-store rows`, `data-store query`, `data-store insert` and `knowledge-base query` use what a Workflow, Data Store or Knowledge Base holds, so a key reaches them only with the **Use** level (German: **Verwenden**) of Settings > API keys. The key `catalyst setup` creates has it ticked. Every call acts as you, with the rights you hold at that moment, and the key never adds one: a right you lose is gone from the key.

| Command | Calls | Needs on the key |
| --- | --- | --- |
| `workflow start <name> [--from <file\|->]` | `workflows.start` | `workflow.use` |
| `data-store rows <name> --table <t> [--limit <n>] [--after <cursor>]` | `data_stores.rows` | `data_store.read` and `data_store.execute` |
| `data-store query <name> --sql <statement>` or `--from <file\|->` | `data_stores.query` | `data_store.read` and `data_store.execute` |
| `data-store insert <name> --from <file\|->` | `data_stores.insert` | `data_store.insert` |
| `knowledge-base query <name> --sql <statement>` or `--from <file\|->` | `knowledge_bases.query` | `knowledge_base.use` |

Each right is the key's own and is limited by its scope (`data_store.execute:<workspace>/<store>`): a key limited to one store or Workflow reaches no other. A key without the level is refused with exit code 1, and the refusal names the right the key lacks. `knowledge-base query` is refused to a key while the Knowledge Base reads data from a Connection that is not open to outside clients. Beyond these five the level opens no row operation: a key changes or removes no row, reads no preview, value or flagged record, and starts no re-index.

`workflow start` starts the published Workflow, which acts as its own technical account, and answers the run; follow it with `workflow run` and `workflow steps`. Its `--from` file is `{"input": {...}, "key": "<run key>"}`; both fields are optional. The Workflow must be turned on for outside clients. `data-store rows` prints one page; pass the `next` it printed to `--after` for the following page. `data-store query` and `knowledge-base query` take one read-only statement, with `$1`-style placeholders and `parameters` in a `--from` file (`{"sql": "...", "parameters": [1]}`); `knowledge-base query` also takes a named query, `{"query": "<name>", "parameters": {...}}`. `data-store insert` takes `{"table": "...", "rows": [{...}], "onConflict": "fail"}`, at most 1,000 rows. These calls are recorded like the same calls in the app, without the values.

## Instance commands

These read the instance and change nothing. A key reaches them only with the **instance level** of Settings > API keys (German: **Alle Arbeitsbereiche**), which you tick by hand for a key over the whole instance. The key `catalyst setup` creates never carries it, and a key limited to a workspace cannot. Every call acts as you, with the rights you hold at that moment, and the key never adds one: a right you lose is gone from the key, and you cannot issue a key with a right you do not hold.

```sh
catalyst usage show
catalyst usage breakdown --start 2026-10-01 --end 2026-11-01 --group-by model
catalyst audit events --limit 100
catalyst audit activities
catalyst jobs summary
catalyst jobs list --status failed,dead
catalyst operation runs --effect changing --since 2026-10-28T00:00:00Z
catalyst operation show <run-id>
catalyst modules list
catalyst infrastructure show
```

| Command | Calls | Needs on the key and on you |
| --- | --- | --- |
| `usage show` | `usage.get_summary` | `usage.view` |
| `usage breakdown --start <day> --end <day> --group-by <dimension>` | `usage.breakdown.get` | `usage.view` |
| `audit events`, `audit activities` | `audit_events.list`, `audit_activities.list` | `audit.view` |
| `jobs summary`, `jobs list` | `instance.jobs.summary`, `instance.jobs.list` | `system.view` |
| `operation runs` | `operations.list_runs` | `system.view` |
| `operation show <run-id>` | `operations.get_run` | none for your own call; `audit.view` for another person's |
| `modules list` | `instance.modules.list` | `system.view` |
| `infrastructure show` | `instance.infrastructure.get` | `system.view` |

A key that names none of the three rights, or not the one a command needs, is refused with exit code 1, and the refusal names the right. The level opens no decision, no retry of a job, no change and no right: it does not reach users, rights, technical accounts, credentials, spend limits, usage by named person or the Inbox. `catalyst models check` runs on `system.view` as before.

`audit events` shows the instance's audit events, which record who did what to which subject and never the content of a request, a reply, a file or a secret. `operation runs` and `operation show` name an input by its hash and hold neither the input nor the result. `jobs list` leaves out a job's payload. Reading the audit events is itself an audit event, attributed to you and to the key. `audit events`, `jobs list` and `operation runs` print one page of 50 entries, or `--limit` up to 200, with the `nextCursor` to pass to `--cursor` for the next; the other commands print the whole answer. `jobs list --status` takes one status or several separated by commas: `queued`, `running`, `succeeded`, `failed`, `dead` or `cancelled`. `operation runs` also takes `--operation`, `--effect reading|changing`, `--status`, `--actor`, `--origin` and `--workspace`.

## Other commands

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
