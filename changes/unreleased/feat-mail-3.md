---
section: Added
---

- **Workflows:** The canvas shows a Send email step (`mail.send`): "Sends an e-mail" with the sender's icon (the assembly's `system-mail` mark, else the generic mail icon) and name, a line with the first recipient, how many more and the subject, and "Sent to 3 at 07:42", a test send or "Simulated" once it ran. The transport is never named.
- **Workflows:** The panel of a Send email step shows the mail in the instance's frame: the sentence, From, To, Cc, Bcc, the subject and text with each value of an earlier step as a chip, the text folded to 12 lines, "Replies go to", the language and where the instance may send. "This run" shows the mail as sent, simulated or sent as a test, its body only to a reader who is given the step run's input.
- **Workflows:** The Settings of a Send email step write the sender's display name, To, Cc and Bcc (people, workspaces, typed addresses or one list field of an earlier step), the subject and the Markdown text with "Insert a value" chips in the `text` form, a preview with the last run's values, and "Replies go to" and the language under "More". An address outside the instance's recipient domains is marked before Save. The palette's "Send an e-mail" adds the step as the instance's own sender.
- **UI library:** `MailPreview`, `RecipientField` and `TemplateTextField` (with `TemplateText`), each with a gallery entry.
