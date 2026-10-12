# Migrations

Generated with `pnpm db:generate --name <name>` and committed with the schema change. Migrations land in number order.

## Two lines of work that both add migrations

No number is reserved. `pnpm db:generate` compares the schema with the latest snapshot under `meta/`, which it finds by file name, and numbers the new file after the last entry of `meta/_journal.json`. A migration that was renamed to another number, or generated against a snapshot that is no longer the latest, gives a wrong next migration. So:

1. Each line generates its migration on its own branch as usual. It gets the next number, and both lines may hold the same number until one lands.
2. The line that lands first changes nothing.
3. The line that lands second rebases onto the new main and generates again. Take main's version of `meta/_journal.json` and of every file under `meta/`, delete your own SQL file and your own snapshot, keep your schema change, then run `pnpm db:generate --name <name>` once more. The new file has the next number and its snapshot holds both lines' tables.
4. Read the generated SQL. It must hold only your own change. A statement for the other line's tables means the rebase lost part of the schema.
5. Put any hand edit of the first SQL file, such as a data movement, into the regenerated one.

A migration is never renamed and a journal entry is never edited by hand. A migration that has run on a database outside your machine is never regenerated: add a new one.
