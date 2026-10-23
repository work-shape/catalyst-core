---
section: Added
---

- A person's own confirmation settings (OP-6): per operation Always allow, Ask me or Never, for the calls their own agents make, chat and scheduled runs alike. A confirmation card in chat and a confirmation in the Inbox offer "Always allow" only where it would let the next call run; a floor, a guardrail, an approval or an admin's lock keeps asking. Never refuses the call before it runs and keeps the tool from the agent. Settings are listed and changed under Settings > You > Confirmations through `me.operation_settings.list` and `me.operation_settings.set`, by the signed-in person only; each change is audited as `user.operation_setting_changed` with the operation and the value alone. Workflow calls and other people's calls are never affected.
- Release config `policy.alwaysAllow.locked` names operations (or `prefix.*`) for which nobody may set Always allow. Only reversible operations permit it at all; irreversible, outward and undeclared ones never do.
