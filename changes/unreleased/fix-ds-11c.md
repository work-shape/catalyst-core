---
section: Fixed
---

- **Data Stores:** Errors retain constraint, table and column names only when PostgreSQL identifies a constraint-checking routine. PL/pgSQL `RAISE` diagnostics and errors without routine metadata use the fixed SQLSTATE sentence, keeping row values out of errors and Operation Runs. Real unique, check, foreign-key, exclusion and not-null violations retain their names.
