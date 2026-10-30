---
section: Added
---

- **Drafts (DT-1b):** The draft of an App and of a Workflow has one head under its page head: **Draft · reads live data · changes are simulated**, each Data Store whose test copy the draft writes to (a link to the copy), and the live version with who published it and when, or **Not published yet**. A Workflow's head also counts the steps the draft adds, changes or removes.
- **Apps:** Under "Technical details", **Files** marks each file **New**, **Changed** or **Removed** against the live version and opens a marked file as its line-by-line difference to the live text. The publish dialog lists each changing action the publish makes live, marked **New** or **Changed**, and marks the outside hosts it adds.
- **Workflows:** The canvas of a test run marks each operation step with where its call went: **Live**, **Test** or **Simulated**. The publish dialog lists each changing step, new or changed, and the outside hosts it adds.
- **Instance > Operations:** A **Target** column says where each call went: Live, Test or Simulated.
- **API:** `assets.get` answers, for an App or a Workflow, `liveVersion` (now for Workflows too), `publishChanges` (the changing calls new or changed against the live revision, and the hosts added, for a reader who may publish; the same list the publish approval shows) and `draftTestCopies` (the Data Stores whose test copy the draft's calls reach, for a reader who may write).
- **Interface library:** `DraftHeader`, `ChangeList`, `ChangeTag`, `TextDiff` with `diffLines`, and a `target` marker on flow nodes.
