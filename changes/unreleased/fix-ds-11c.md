---
section: Fixed
---

- **Data Stores:** Errors retain constraint and table names only when PostgreSQL identifies a constraint-checking routine and the constraint still exists on that table in the store's catalog after rollback, read as the platform role. Not-null errors check the column on that table instead. The error path makes one catalog query per candidate failure, with no per-row cost. PL/pgSQL `RAISE`, missing routine metadata, unverified names and objects created inside the rolled-back transaction use the fixed SQLSTATE sentence, keeping row values out of answers, logs and Operation Runs in EN and DE. Existing unique, check, foreign-key, exclusion and not-null violations retain their names.
- **Accepted residual:** A schema author can choose which existing constraint to break based on a value, leaking it one choice at a time. The schema author already controls the store's schema by design, so this is accepted.
