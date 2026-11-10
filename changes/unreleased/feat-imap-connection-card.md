---
section: Added
---

- **Connections:** New connection shows the card "Mailbox (IMAP)": server, user name, password
  or app password and folders, the port under Technical details. Connect saves the Connection,
  sets the password as its secret only and tests it; both reading operations are then ticked
  for approval, and "May use them" offers Agents only. A connector type's form may name a
  field's value kind (number or list), its default, a field under Technical details, and a
  sentence of what everyone who may use the Connection reads.
- **Connections:** `platform.connections.propose` takes `settings` for a type with a form of its
  own, such as `imap` with host, port, user name and folders. It refuses a secret field.
- **Skills:** A `skill_change` request filed from a conversation that read what only its
  person may read, such as a mailbox, carries the flag `markedConversation` and no content; the
  Inbox shows "Prompted by an email from outside" on it.
