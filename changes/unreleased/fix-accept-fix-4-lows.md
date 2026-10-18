---
section: Fixed
---

- Lower per-person token safeguards to 200 million per UTC day and 4 billion per calendar month; keep 20,000 calls per day. Own and product calls retain separate buckets. Reduce the unattended factor from 10 to 7: its 1.4 billion tokens/day allow at most 23 h 20 min at 2 million counted tokens/minute even across a UTC reset. Explicit overrides retain their configured values.
- Name the exhausted metric, period, own/product/instance scope and UTC reset in usage refusals and English/German chat notices. The optional `error.usageLimit` carries `period`, `metric` and `scope` through observations and reloads. Older run errors without these details keep a generic notice. An own-call refusal reads: `Daily model call safeguard has been reached for your own calls. Resets at midnight UTC.`
- Share attachment-only conversation title placeholders between title replacement and the chat dictionary.
- Keep Knowledge Base embedding and field-extraction ingestion usage out of chat safeguard and spend counters, including settlement, lazy initialization and reconciliation, as required by KB-ISO and the limits spec section 3.1. Query embeddings still count as chat.

- Use settled daily and monthly spend excluding Knowledge Base ingestion for Usage budget bars and headroom; keep ingestion costs in totals, history and attribution.

Rollback restores the higher token defaults and can count ingestion against chat again; reconciliation must complete to correct counters left by the previous release. No migration is required. Assemble the paired capabilities change after this core change to classify KB field-extraction calls as `knowledge_field_extraction`; older capabilities keep their existing classification.
