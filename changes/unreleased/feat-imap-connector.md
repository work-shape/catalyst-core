---
section: Added
---

- **Connections:** The connector type `imap` reads a functional mailbox over IMAP with implicit
  TLS and the Connection's password. `search_messages` searches one of the Connection's folders,
  newest first; `get_message` reads one message's headers, text and attachment names. Folders
  are opened read-only and bodies read with `BODY.PEEK`, so no flag changes; attachments are
  never downloaded. The password is bound to the server and the user name.
- **Connections:** A connector type may declare `privateResults`: what it answers is one
  person's to read whatever the Connection's credential mode. Every call of such a type is a
  personal call, and its operations accept exposure `agent` only. `imap` declares it.
- **Connections:** `egress.allow` takes the protocol `imaps`. `egress.allowPublicHttps` does not
  open it.
