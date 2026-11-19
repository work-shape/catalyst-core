---
section: Changed
---

- **Knowledge Base page:** a document's row stays one line of name and one of facts. The link to
  its original is an icon button among the row's actions instead of a chip with the host. Two
  files of one name from two folders are told apart: a synced document's row names its folder
  before the format and the size, cut with an ellipsis where it does not fit. That the originals
  stay at the source is said once, in the synced folder's row, and no longer in every document's
  row. A synced folder's row opens by itself only for a confirmation the reader must give; failed
  items show as a count in the row, and the failed documents stand first in the list as before.
- **API:** `GET /api/v1/knowledge-bases/{knowledgeBase}/documents` answers one more optional,
  read-only field per document, `folder`: the folder of a synced document below the folder that
  is synced, without the file name (`/` at the top), absent for a file added by hand. It is the
  folder part of the `path` a search match already carries, for the same right.
