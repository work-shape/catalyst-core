---
section: Fixed
---

- Explain refused row writes in English or German with the affected column and type, without SQLSTATE or database diagnostics.
- Keep Skills' opening scope local to Skills, explain approval before a member saves a skill, and warn when a Workflow account cannot use a required Connection.
- Clarify sign-in failures and correct labels, dates, refreshes, attachment warnings, Inbox comparisons, and continuing a conversation privately.
- Show approval before a member creates a skill on the new-skill page and in `platform.context`, and return `saveApproval` from `read_skill` as `platform.assets.get` does.
- Name only approvers whose grant covers the request, point an agent at `platform.assets.get` for a skill it does not hold, and say in plain words why `read_skill` refuses one.
- Keep the outage message of a refused row write, and tell the caller to check the table before writing again when a keyless write may already be stored.
