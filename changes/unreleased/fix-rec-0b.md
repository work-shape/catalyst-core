---
section: Fixed
---

- **Data Stores:** Every migration preserves records keys that held before its pending batch, rolling back with `record_key_invalid` naming the offending migration, rule and key. The final migration also checks keys created by the batch, allowing a table and its unique key in separate files. If a new table's batch fails before adding its key, the table remains and the failure says the records key is not there yet. Migration jobs keep the latest published rules and target revision when another publish arrives during a running migration.
