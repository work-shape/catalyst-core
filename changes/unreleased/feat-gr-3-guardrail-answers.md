---
section: Added
---

- A guardrail's answer shows where the person acts: on the card of a refused tool call in chat (its work history opens on it), on a refused App action, on the confirmation card of a call a guardrail warned about, and in the Inbox item of a call a guardrail held. Each answer names the guardrail, its reason, its outcome, its scope and version, and who can change it (the publisher of the version and the holders of `guardrail.publish` at its scope, or "set by the operator" for the release floor), with a way to ask them.
- Rules in force (Settings › You): a read-only page for every signed-in person that lists the operator's floor, the shipped guardrails and the guardrails published for the instance and the viewer's workspaces, who changed each and when, and a 30-day count. People are named only where the directory lets the viewer see them; the count carries no payloads and no one who was stopped.
- `guardrails.in_force` (`GET /api/v1/guardrails/in-force`) lists those rules, and `guardrails.ask` (`POST /api/v1/guardrails/{name}/ask`) sends a question about a rule to the Inbox of who can change it; the floor answers 409 `set_by_operator`.
- A refusal by a guardrail carries the answer in `error.details.guardrail`; a waiting call carries the guardrails that warned about or held it on its decision and its approval preview.
