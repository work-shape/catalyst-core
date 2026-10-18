---
section: Fixed
---

- **Data Stores:** Constraint errors now identify the constraint and table in English and German, including dataset loads and records proposals, without exposing rejected row values. PostgreSQL 17 not-null errors identify the table and column because the server supplies no constraint name. Database detail text is discarded.
