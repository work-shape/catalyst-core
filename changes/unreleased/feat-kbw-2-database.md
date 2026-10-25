---
section: Database
---

- **Knowledge Bases:** Owned-store migration 14 `item_removal_hold` (applied to every Knowledge Base store at the next start, no platform migration): source items get a nullable `removed_at`, set only on an item a person removed by hand, with a check that such an item is withdrawn and a partial index for counting them. Every existing row keeps `removed_at` null, so the check holds on them as they are. A rollback keeps the hold: a pass of an older release that names a removed item fails on the check rather than bring it back, so remove the hold (`update catalyst_kb.source_items set removed_at=null`) only where a person decided to.
