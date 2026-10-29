---
section: Fixed
---

- **Embedded chat:** A confirmation card in an embedded chat no longer reads its Operation Run, which needs `governance:read` and which a host's session token does not hold: the read answered 403 and the card kept Allow and Deny disabled until it failed. The card has no Inbox item to lead to there, so it answers in the conversation at once.
