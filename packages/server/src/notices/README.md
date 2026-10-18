# Notices and notice mail

`createNotices` is the existing internal port: instance user ids and Shared Workspace members
are resolved once, with the same active-user, unknown-recipient and addressee-only Inbox rules.
A `notify` step resolves its title/text mappings before settling. Its Inbox writes, outbox
references, audit and step completion share the run transaction; a recovered settled step
creates no duplicate. A test run addresses only its tester.

Mail never renders a notice title, paragraph, run value, client name or finding. The typed
`workflow-notice` template receives a notice count and the instance's Inbox URL. The outbox
keeps only notice and recipient ids and a due time. The worker reads the current address and
active state immediately before sending, and uses the existing configured mail transport.
No free address is accepted by the notice port. Provider region and credentials follow the
instance's `infrastructure.mail` adapter configuration; there is no new provider account.

`infrastructure.mail.notices.batchSize` (100) bounds recipients served by one tick;
`digestIntervalMs` (300000) sets both the minimum batching window and tick interval. Both
are positive operator settings without a fixed upper ceiling. A recipient's due notices
are counted in SQL and sent in one digest, without loading notice content. A large backlog
is drained over subsequent ticks. A failed provider call retains its rows and defers their
due time, so a permanently failing recipient cannot monopolize the front of the next batch.
A tick and its lease are instance-wide; no process owns a timer or an in-memory queue.

Outbox references are deleted on successful handoff, recipient deletion or notice deletion.
Disabled/deleting users' due rows are discarded; an address removed since enqueue defers
mail until the address is restored. If mail was absent when requested, the notice remains
in the Inbox and is counted as unsent. Provider failure text is never logged or audited.
The audit records counts and delivery success only, under normal audit retention.

Delivery is at least once: a crash after provider acceptance and before committing removal
can repeat a digest. No mail transport offers a transaction with our database.

Each root end queues a failure-notice job in its transaction. That job counts failed and
limited runs under the root in SQL and writes one Inbox notice, including for a successful
root with failed children. A marker and the Inbox write commit together under the root lock.
The addressee is the publisher recorded for the root's revision, or the tester in test mode.
Publisher records live with the revision; failure markers live with the root run. Migration
0114 backfills publishers from retained successful publication audit events. An older revision
without such an event needs republishing to establish attribution. Folder definitions have
no publisher and produce no failure notice. Failure Workflow dispatch remains held for EW-13.
