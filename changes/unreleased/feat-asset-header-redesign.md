---
section: Changed
---

- **Studio asset pages:** The head of an agent, skill, App, Workflow, Knowledge Base and Connection page says each thing once. One status pill after the name ("Draft · not live", or a quiet "Live") opens a popover with the draft's version, who saved it and when, the live version and "View changes". One muted line under the name gives origin, default and audience ("Ships with the platform · Default in all workspaces · for everyone"). The head description, the chip row and the draft banner are gone. Publish is the one primary button, shown only while the draft differs; History, copy, reset to shipped, discard and the other actions are in the "…" menu. A shipped asset's read-only notice offers "Copy to edit" beside its words.
- **Agent fields with a draft:** Texts have a segmented switch "Draft | Live | Changes" that shows the live text or only the changed lines in the field's own box, so the page never grows. One line under the field says "Differs from live in N places · own version instead of the shipped one", showing only the parts that apply. The section badges and per-field reset links are gone.
- **Chat and Try:** On an agent page whose agent has a draft, the head's "Chat" opens Try on the draft. The separate "Try" head button is gone.
- **UI library:** `StatusPill`, `VersionedText`, `TextVersionSwitch` and `changedPlaces` are new, and `PageHeader` takes `status` and `meta`.
