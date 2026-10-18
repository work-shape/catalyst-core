---
section: Fixed
---

- **Workflows:** Schedules now record a refused published definition as a skipped tick with its reason and queue the next due time. Schedule repair at process startup is covered by a restart regression. Concurrent due times of one Workflow serialize overlap admission within the run transaction. No migration or job payload change is required.
