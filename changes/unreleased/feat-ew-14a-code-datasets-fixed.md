---
section: Fixed
---

- A dataset row that does not fit its row schema no longer puts a key of the row into the
  error stored with the run and step: the error names the line and the place of the field by
  position (`field 2, item 1`), never a key or a value.
