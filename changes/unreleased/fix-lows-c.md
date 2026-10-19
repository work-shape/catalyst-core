---
section: Fixed
---

- Inbox lists no longer carry `input`. An opened held asset save also withholds executable input and technical input fields unless its preview establishes read access, including when the asset's module was disabled while waiting.
- Data Store updates refuse changes to the source columns of generated primary keys with `key_column_in_set`, keeping row identity stable.
- German callers receive localized unreadable and deeply nested operation input errors. Workflow test refusals name the right in plain language, and historical step panels show the run's account.
- Agent guidance uses plain save and creation wording, supplies revision numbers when asked, and explains how a member submits a skill change for an administrator's decision.
