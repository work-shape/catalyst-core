---
section: Added
---

- `catalyst docs` and `GET /api/v1/context/docs` read the instance's stored release documentation; `catalyst context` prints an update notice when its CLI version is older than the instance names.
- Changed: `instanceActions` is narrowed by the credential's callable operations; unknown CLI commands exit 2 even with `--help`.
- `catalyst keys --help` and `catalyst instance --help` show the named commands, and a kind's id such as `data_store` is accepted for help.
