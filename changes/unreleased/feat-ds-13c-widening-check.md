---
section: Added
---

- **Widening check (DS-13c):** At a Workflow publish, an App publish or audience change and a Knowledge Base publish, the instance checks that everyone who reads a Data Store's rows may use each of its sources (`connection.use`). The publish question says so in one line, or says per source how many readers may not use it, never who. A publish that newly hands a source's data to such readers is refused (`data_handover_needs_owner`) unless the caller holds `connection.write` on the source; that holder confirms with `assets.publish` `confirmHandover` (CLI: `--confirm-handover`), which the question's `publishHandover.confirmation` gives (`data_handover_unconfirmed` otherwise). Each confirmed hand-over is audited as `data_store.handover_confirmed` with a count of people. The check runs on the server inside the publish; the interface only shows its answer, and words both refusals in German and English.
