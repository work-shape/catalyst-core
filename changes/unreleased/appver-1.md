---
section: Changed
---

- **Apps:** A version is a publish. The draft's head says "Live: version 4 · since Oct 26", adds "Draft: changed since version 4" while the draft differs, and says "Draft · not published" before the first publish; no member text shows a revision number any more (the list says "Published", the agent's save line "Draft saved", the publish dialog "this state"). History lists one row per version, newest first, with who published it and when, and folds the draft saves made after it under it ("3 draft saves"); each save names the person, "Workshaper for {name}" when an agent saved it, or "Saved from the preview". "Publish this save" on a save publishes it as the next version. `assets.get` of an App answers `liveVersion` and `draftChangedSinceLive` for a reader of its draft in place of `publication`; `assets.publications.list` lists an asset's versions; a revision an agent writes carries the origin `agent_run`, or `byAgent` on its Page origin.
