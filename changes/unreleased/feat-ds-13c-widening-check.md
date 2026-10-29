---
section: Added
---

- **Widening check (DS-13c):** At every change that widens who reads a store's rows or adds a source to it, the instance checks that everyone who reads the rows may use each of its sources (`connection.use`). The changes are the publish of a Workflow, an App (with the Workflows published with it), a Knowledge Base or an agent, an App's audience, `assets.set_availability` of a Knowledge Base and `assets.move`. A Knowledge Base with synced sources counts as a store of its own, read by whoever may use it. The publish question says in one line that the check holds. Where it does not, it says per source how many readers may not use it, never who.
- A change that newly hands a source's data to such readers waits in the Inbox, and no policy turns that off. The approver must be a person who also holds `connection.write` on each source, and their approval is the confirmation.
- A person who holds `connection.write` can confirm directly with `confirmHandover` (from the question's `publishHandover.confirmation`) on `assets.publish`, `assets.set_availability` or `assets.move`. In the CLI this is `--confirm-handover`. API keys, service principals and agents are refused (`data_handover_person_only`), and so is a stale confirmation (`data_handover_unconfirmed`).
- When the check cannot read every published asset, it counts that as a gap and never lets the change pass silently.
- Each confirmed hand-over is audited as `data_store.handover_confirmed`, in the change's transaction, with a count of people.
- The check runs on the server; the interface only shows its answer, in German and English. An agent's publish card says that a person confirms the hand-over in the Publish dialog.
