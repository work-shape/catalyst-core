---
title: Actions on a Data Store
description: How an App reads and inserts records of its Data Store with sql actions, how the statement declares its parameters, what it answers, and how the agent creates the store's draft.
---

Part of [Build an App](/apps/build/). What every action shares, drafts and publishing: [App actions](/apps/actions/).

## An `sql` action

The statement is one file. Its first lines declare the parameters, and the statement names each as `$name`:

```sql
-- @param client text optional
select id, client_id, title, created_at
from findings
where $client is null or client_id = $client
order by created_at desc
limit 100
```

The manifest says what the statement does, with one line for it:

```yaml
actions:
  - { name: list-findings, file: actions/list-findings.sql, effect: reading }
```

- A parameter line is `-- @param <name> <type>`, with `optional` after it where a call may leave it out. A type is `text`, `integer`, `number`, `boolean`, `date` or `timestamp`, or one of them followed by `[]` for a list.
- A `reading` statement is one `SELECT` or `WITH`.
- A `changing` statement is one `INSERT` of one row whose values are all parameters, with `on conflict do nothing` after it where an existing row is skipped.
- A value is bound to its place in the statement and never written into it.

A reading statement answers `{ columns, rows, truncated }`: `rows` is a list of objects by column name, at most 1,000 rows and 2 MiB, and `truncated` says the result was cut; page with `limit` and `offset` parameters. A `numeric` value comes as text. An insert answers `{ table, inserted, skipped }`.

## The Data Store

The App lists its Data Store under `dataStores` in `app.yaml`, by name, with `minSchema` where it needs at least that migration of the store. The `dataStores` module has to be on. Where the App needs a Data Store that does not exist yet, the agent creates its draft in the same conversation with `platform.assets.put` (kind `data_store`, its files `store.yaml` and `migrations/0001_<name>.sql`), after it says what it creates. The draft stays beside the App: the conversation stays about the App, and the person stays on the page they are on. The agent keeps saving the draft from that conversation, and a person publishes it, which applies its migrations. A person can also write a store with `catalyst data-store put`. The statements read and write the tables those migrations made.

An `sql` action runs only in an App: in a preview that is not yet saved a reading `sql` action is refused with `data_store_needs_app`, and a changing one with `draft_safe_mode`. In the App's draft it runs with the viewer's own right on the store: to read it, and for an insert, which the draft simulates, to insert.
