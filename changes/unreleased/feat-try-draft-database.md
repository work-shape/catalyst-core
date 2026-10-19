---
section: Database
---

- **Agent Try:** Rekey agent Try conversations by agent and person with migrations 0131–0132. Existing previews keep the newest current conversation per person; older links remain available for retention cleanup. Publish, Discard and agent deletion remove previews; Build deletion leaves them. Migrate before starting the new API and workers. New refusal texts: a queued Try turn without a valid snapshot ("The preview snapshot is not available. Send the message again in Try."), a tool Try does not offer ("This tool is not available in Preview") and moving a Try conversation ("A preview conversation stays with its agent"). Rollback keeps the nullable legacy Build and creator columns; previews opened by the new release cannot be reopened by the old Build-keyed endpoint. After old workers drain, the legacy Build column and nullable creator compatibility can be contracted in a later release.
