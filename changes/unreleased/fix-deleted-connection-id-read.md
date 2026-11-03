---
section: Fixed
---

- **New connection:** An id that only a deleted Connection held no longer makes the dialog read that Connection, which the instance answered with 404 and the browser logged as an error. The dialog now asks the id's history first and reads the holder only where the id is not a deleted Connection's.
