---
section: Fixed
---

- **Knowledge Bases:** A declared filter on `document_type` no longer fails every search it
  narrows with SQLSTATE 42883: its statement called `coalesce` as a function of the catalog.
