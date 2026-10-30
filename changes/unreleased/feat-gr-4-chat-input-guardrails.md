---
section: Added
---

- Guardrails on chat input: the event `message.before_send` checks a person's chat message, its text and the text of its attachments, before it is stored or any model reads it. Only `pattern` checks run there, inside the instance; `model_judge`, `code` and `require_approval` are refused at start. A `pattern` may add `checksum: luhn`.
- A block refuses the message (403 `GUARDRAIL_BLOCKED`, `details.reason: chat_input_blocked`): nothing is stored and the draft stays in the composer. A warning refuses it (409 `CONFLICT`, `chat_input_warning`) until the person sends it anyway, which sends `acceptGuardrailWarnings: true`. The composer shows the guardrail's answer, and "Trotzdem senden" for a warning, on a new conversation, an idle one and a queued follow-up.
- Four default rules join the operator's floor: `chat-secrets` and `chat-card-numbers` block, `chat-passwords` and `chat-special-categories` warn. There is no rule on an IBAN or a tax ID. `chatInputGuardrails` in release config switches each off; a guardrail of the same name in `guardrails` takes its place.
- What the checks could not read is said, never passed silently: an image, a file whose text is extracted after sending (PDF, Word), an unreadable or too large file, and text beyond what a pattern reads, in `chatInput.attachmentsNotChecked` and `chatInput.textNotChecked` of the answer and of the refusal.
- A chat hit keeps the rule, the message id, the field and the match count, never text. Chat hits are counted by rule on a guardrail's page and on Rules in force and are not listed.
- The run stream has the observations `message_held`, `message_released` and `message_withheld { guardrailId, reason }`, and the run projection a `hold`. Deltas of a held answer are buffered and never stored or streamed when it is withheld. Every client renders them; nothing emits them yet.
