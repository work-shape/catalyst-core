---
section: Fixed
---

- Refuse App exposure (`bridge`) on a Connection with a person context header until Apps support person context, whether adding the header or enabling App exposure. The API returns 422: "Person context is not available in Apps yet. Remove App exposure or the person context header." The interface explains the refusal in English and German. Removing either setting allows the save.
- Stop startup on release config that defines a Connection with both a person context header and App exposure. The release seed and an administrator's save ask the same rule.
- Refuse any call an App action makes of a Connection that sends person context as `person_context_app_unavailable`, before any request reaches the outside system, whoever calls the action: a frame, an agent that carries the action as a tool, or anything else. This also covers a Connection stored before the save refusal and one the action reaches by agent exposure. An agent's or a Workflow's own call of the Connection still sends the mapped value.
- Clarify that Workflow tests send the tester's mapped value on root and child runs, and require a bounded `SET lock_timeout` for migration DDL that takes table locks.
