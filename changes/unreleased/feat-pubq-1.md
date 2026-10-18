---
section: Added
---

- Publish reviews for Apps and Workflows lead with a plain sentence in the reader's language describing when they run, whose account they use, what they read, write and send, and who sees the stored data. Details retain the existing data, rights and revision review. The interface, interactive CLI and held publish Inbox item warn about steps that an active approval guardrail will stop.
- Publish warnings dry-evaluate the runtime policy and guardrails for operation and child Workflow steps, using each operation's resource workspace. They also name policy approvals, distinguish known pattern matches from conditional checks, and show one Details fold with locale-correct English and German copy.
- Runtime policy resolution (`packages/core/src/operation-policy.ts`) identifies an operation's minimum policy as `policy_floor` when it raises a central setting, so publish warnings name the policy that actually stops a step.
- Publish narration checks up to four steps concurrently under a shared three-second budget. Failed or unfinished input checks name steps that may stop; a failed summary leaves Details and publishing available in English and German. Published guardrails are read once per narration.
