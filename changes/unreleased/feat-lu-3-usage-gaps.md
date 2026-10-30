---
section: Added
---

- **Usage:** The Breakdown by agent gets a Feedback column while the feedback Module is on. It counts the comments each agent's answers received in the period, as a count only, never who wrote them or what they said. For someone who reviews feedback, a count links to their Inbox filtered to that agent, at the new address `/inbox/agent/<name>`. Below the table, for the whole instance or one Shared Workspace, a line names the agents offered there that caused no usage in the period.
- **Usage:** A Download CSV button on the Breakdown writes the table as shown: one row per value, then the total. Amounts are plain numbers in the instance's currency, and a cell that would start a spreadsheet formula is escaped.
- **Usage:** A Shared Workspace's Usage tab shows today's cost and the month's projection beside the month. Where a spend limit applies to the workspace, a card shows how much of the day and month limit is used.
- **API:** `usage.breakdown` rows grouped by agent carry `feedbackCount`, and the Breakdown carries `feedback.reviewable` and `unusedAgents`. `workspaces.usage` carries `today` and, where a limit applies, `limit` with its day and month and the currency.
