# Migrations

Generated with `pnpm db:generate --name <name>` and committed with the schema change. Migrations land in number order.

## Reserved numbers

Two lines of work run side by side and each adds migrations. A range is reserved so neither renumbers the other's files. Delete a line when its range is used up or given back.

| Numbers      | Reserved for                                                |
| ------------ | ----------------------------------------------------------- |
| 0057 to 0059 | Workflows: run and step run tables, schedule rows           |
| 0060 to 0062 | Data Stores and Knowledge Bases: store records, their roles |

A number is the label of a file. A database applies migrations in the order of `meta/_journal.json`, by its timestamps, and `pnpm db:generate` numbers a new file after the last journal entry. So a migration whose reserved number is not the next one is generated as usual and then renamed to its number in three places: the SQL file, its snapshot under `meta/` and the tag in the journal. Its timestamp stays as generated. After a rebase onto a main with new migrations, delete your SQL and snapshot, take main's journal, generate again and rename again. A range that turns out too small takes the next free number after 0062.
