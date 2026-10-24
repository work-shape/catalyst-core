---
section: Changed
---

- Core owns the hook at every before-event: `BeforeActionCheck`, its input and call context, `NO_BEFORE_ACTION_CHECK` and `combineBeforeActionChecks` in `@work-shape/catalyst-core`. The guardrail runner is one such check. A capability can contribute another through `beforeActionCheck` on its contribution; the assembly combines it with the guardrails and hands the result to operation calls, the event emitter, the approval-request workflow and the publish question, and the strictest answer of all is the event's. `createOperationCalls` now requires `checks`, so a process that forgets the wiring fails to build; a process that checks nothing passes `NO_BEFORE_ACTION_CHECK`. Behaviour is unchanged.
