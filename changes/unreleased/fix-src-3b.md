---
section: Fixed
---

- Synced documents from before owned-store migration 5 remain searchable without another sync. A null listing key remains visible: no operated instance has synced document-source items yet (the only connector is `fixture`; Box arrives in CS-6), so these legacy rows exist only in tests. A published boundary change hides unknown-parent items whose listing key belongs to a different boundary and queues a full pass. Only a person's full sync (including a personal API key) replaces a pending withdrawal confirmation; changes polls, Workflows, retries and answered confirmations join the held pass. Competing decisions return `CONFLICT` (409). Replaced passes end as `superseded` without a source failure.
