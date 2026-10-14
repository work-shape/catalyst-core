---
section: Fixed
---

- **A Data Store or Knowledge Base query past `temp_file_limit`:** a statement that sorted or
  generated more than the store role's 1 GiB of temporary files (SQLSTATE 53400) was told as
  the database being unreachable and answered 500 with no sentence. It is now refused as the
  caller's statement with status 422, the SQLSTATE and the advice to narrow or aggregate it, and
  is not retried. Too many connections stays unavailable.
