---
section: Added
---

- Freeze the contract of `mail.send` (MAIL-0): its input (`sender`, `to`, `cc`, `bcc`, `subject`, `body` as Markdown, `senderName`, `replyTo`, `locale`), its output (counts and the provider's message id, no address), the simulated answer with the mail's `preview`, the refusal codes `recipient_not_allowed`, `no_recipient` and `mail_rejected`, and the params of the template `workflow-message`. This registers no operation, sender or template; MAIL-1 does, and only while outbound mail is on.
- `infrastructure.mail.outbound` in release config: `enabled` (default `false`), `recipientDomains` (lowercase domains, `*.domain` for subdomains, `*` alone for every address; default none outside the instance), `limits` (`perWorkflowPerHour` 200, `perInstancePerDay` 1000) and an optional plain-text `footer` per language. Nothing reads it yet.
- The right `mail_sender.use` and the resource kind `mail_sender`. The `admin` and `superadmin` roles hold the right by default; members do not. A service principal may be given it once MAIL-1 registers the kind; until then the grant is refused with `action_not_grantable_to_principal`. It has no grant scope for people yet.
- The audit events `mail.sent` and `mail.refused` in the registry, with counts and domains only; nothing emits them yet.
- The `text` value form (`{ text: [...] }`) and its Markdown limits as types, the step-facts source kind `mail_sender` and the mail sender's facts. `workflowInputValueSchema` does not take the `text` form until EW-TEXT.
