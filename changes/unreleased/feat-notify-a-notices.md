---
section: Added
---

- **Notices:** The platform can leave a notice for people of the instance (NOTIFY-a), the port a Workflow's `notify` step will call (NOTIFY-b). `createNotices(...).send({ from, to, title, text, link, channels })` reaches the active users and the members of the Shared Workspaces it names, each once, and counts the people named who are not active; no address is taken from the caller. An id that names no user or no Shared Workspace of the instance refuses the whole notice and is named in the refusal (`VALIDATION_FAILED`, `details.unknownRecipients`), and a notice that would reach no active person is refused (`CONFLICT`, `details.reason: no_active_recipient`), so no notice is lost without a word. Each person gets an Inbox item of the new kind `notice` that only they see, count and answer: its title, one paragraph, a link to a Workflow run or an App, and "Mark handled" ("Als erledigt markieren"). Not even its sender sees it. With `mail` they also get the new `workflow-notice` mail, which links to their item and holds no word of the title or the text, so nothing the author wrote leaves the instance by mail. The audit event `notice.sent` holds counts only: addressees, people named who are not active, mails sent and unsent. No migration.

Handled notices show a neutral “Done” / “Erledigt” badge in the Inbox item and list.

- **Fixed:** A request addressed to a person is no longer in its requester's "My requests" (`GET /api/v1/approval-requests/mine`) or in their `mine` counts of `GET /api/v1/approval-requests/pending-count` unless they are the addressee. It is the addressee's alone, as reading it by id already was.
