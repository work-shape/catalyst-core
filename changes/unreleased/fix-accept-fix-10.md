---
section: Fixed
---

- **Language and orientation:** Conversation refusals explain the person's missing right and name an administrator who can help. Orientation and asset names follow the person's language and current workspace; conversation titles follow the conversation language and preserve business names. Studio uses plain German and English labels for guardrails, uploads and Connections. Inaccessible links explain why they cannot open, attachments wait for Send before creating a conversation, and language changes update the document language. Teaching drafts stay out of normal agent pickers, and rights pickers have an opaque surface.

- **Demo:** Fresh seeds keep Kai’s teaching draft out of agent pickers. Existing availability choices are preserved when re-seeding.

- **Review follow-up:** Subagents pass the operation that still needs confirmation back to their parent, while replies to the person keep technical ids out. Tool refusals name the right in plain language and explain who can help. Guardrail hit summaries follow the reader's language.

- **First-message retries:** A failed staged send keeps its conversation until a message is accepted, including retries after all staged files are removed or after the first-message request fails.
