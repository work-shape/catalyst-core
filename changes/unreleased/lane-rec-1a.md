---
section: Added
---

- Data Store records proposals merge document evidence by published precedence and document date, keep unresolved keys and conflicts for review, and project winning values through the atomic load SQL with the same table constraints and size ceilings. Proposal values and quotes stay out of errors, logs and audit. Store provenance lists records Workflows and their readable Knowledge Bases.
- Owned-store migration 8 creates missing pre-REC-0 provenance tables and adds `catalyst.record_fields.content_sha256` with `ADD COLUMN IF NOT EXISTS`; customer stores receive the same additive setup before their first proposal. No platform migration is required. Rolling back leaves the nullable hash column and existing candidates in place; the older release has no proposal handler.

- `records.propose` runs only as a step of a Workflow Run, which owns its failures dataset. Direct chat, App and CLI calls are refused before store work with `workflow_dataset_owner_required`: "`records.propose` runs only as a step of a Workflow Run." The operation is not offered as an agent tool.
