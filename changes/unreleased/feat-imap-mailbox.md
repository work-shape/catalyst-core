---
section: Added
---

- **Connections:** The connector type `imap` lists its folders and puts drafts into the mailbox.
  `list_folders` (reading) answers each of the Connection's folders with its message and unread
  counts, without opening one. `create_draft` (changing, never ticked by the setup) appends one
  plain-text draft to the drafts folder, flagged `\Draft` and `\Seen`: the folder the new setting
  `draftsFolder` names, or else the one the server marks as `\Drafts`. With `inReplyToId` it sets
  `In-Reply-To` and `References` from the answered message. It sends nothing. Addresses, subject
  and text are checked before the server is contacted, so nothing an agent writes adds a header,
  and with the instance default each draft waits for the person's confirmation in the chat. Its
  Operation Run keeps no input or output, as every call of the type. The card "Mailbox (IMAP)"
  asks for the drafts folder under Technical details. The login uses `AUTHENTICATE PLAIN` with
  the password in UTF-8 where the server offers it, which a test now covers.
