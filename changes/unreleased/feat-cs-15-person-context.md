---
section: Added
---

- HTTP API Connections can set `settings.personContextHeader`. An administrator maps each person and service principal on the Connection page. Every outgoing call sends that acting identity's value; an absent, revoked, or origin/header-mismatched mapping fails before dispatch with `person_context_unmapped: the acting identity has no person context on this Connection`. Workflow publication checks each definition's own principal, including children. The setting is off by default.
- Expand `connection_bindings` to store token-free person-context rows, with a scheme/secret constraint and a separate validation migration. Run committed migrations before starting new app and worker processes. Previous releases can drain on the expanded schema; rolling back the application does not undo mappings or preserve person-context enforcement. Disable calls to a scoped Connection before rolling back to code that does not enforce it. Do not reverse the nullable-secret schema while mapping rows exist.
