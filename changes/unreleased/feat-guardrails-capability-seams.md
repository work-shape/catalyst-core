---
section: Changed
---

- The capability SDK gains seams for a capability that keeps platform records: `stores` on the context (the guardrails' store and the published config assets), `instanceSeed` (runs in the API process before it takes a request), `retention` (deletes past the audit retention in the transaction of the audit prune and names its counts in `audit.pruned`), and the model purpose `guardrail_judge` with `instructions` and `reasoningEffort: "configured"` on a model call. A capability's model call that returns a tool call fails.
- The guardrails run as a capability the platform ships built in: their check, their release seed and the deletion of their hits come through these seams, and the `guardrails` module ships with it. A deployment that passes a capability named `guardrails` replaces it. The hits are deleted on time also while the module is off. Release guardrails stay under the `guardrails` key, and the kind, operations and rights stay registered by the platform for now.
- An instance whose `guardrails` module is on refuses to start where the capability that ships the module contributes no check.
