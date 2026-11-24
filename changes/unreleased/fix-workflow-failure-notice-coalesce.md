---
section: Fixed
---

- **Workflows:** a Workflow whose runs keep failing no longer fills its publisher's Inbox with one
  "A Workflow run needs attention" notice per run. While the publisher has not marked the
  Workflow's failure notice handled, the next failing run updates it: it counts every failing run
  since it was opened, links the newest run and moves to the top of the Inbox. Once it is marked
  handled, the next failing run opens a fresh notice. Each Workflow keeps its own notice. Notices
  opened before this release stay as they are.
