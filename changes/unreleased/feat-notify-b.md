---
section: Added
---

- **Workflows and notices:** Workflow `notify` steps deliver Inbox notices as the run's principal, resolving literal and
  reference title/text mappings. Test runs address only their tester. Each root run produces
  one failure notice for its revision's publisher, with a count of failed or limited runs.
  Publishing discloses each notify step's user and Shared Workspace recipient ids and channels.
  `onFailure: workflow.<id>` remains refused as `not_supported_yet`, naming EW-13.

- **Mail delivery:** Notice mail uses the existing typed mail adapter and a durable outbox. Digests carry only
  notice counts and an Inbox link; title, text, client names and findings remain inside the
  instance. `infrastructure.mail.notices.batchSize` defaults to 100 recipients per tick and
  `digestIntervalMs` to 300000; both are positive operator settings with no business cap. An interval outside the supported
  date range is refused as `digestIntervalMs must produce a valid delivery date`.
  Digests count only notices still waiting in the Inbox; handling them all suppresses the mail.
  Provider failures remain queued for a later tick; disabled recipients are suppressed.
  Delivery is at least once: a process crash after provider acceptance can repeat a digest.

- **Database:** Apply migration `0114_notice_mail` before API/worker startup. It adds outbox references,
  revision publisher attribution and root-notice deduplication without changing existing
  notice items. Existing revisions are attributed from retained publication audit events;
  where those events are gone, republish to establish the publisher. A missing migration is
  refused at startup as `The database is behind this release. Run the migration step before starting. Missing migrations: 0114_notice_mail`.
  Rollback leaves these additive tables in place; the previous release sends notice mail
  inline and does not drain this release's outbox. No provider or customer account is set up.
