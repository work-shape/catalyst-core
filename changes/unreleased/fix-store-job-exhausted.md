---
section: Fixed
---

- Data Stores record `job_exhausted` when a provision or migrate job loses its final lease. An App publish refuses promptly with a reason and recovery step in German or English; manually retrying the job clears the store failure. The job executor also runs `onExhausted` for non-retryable failures.
