---
section: Fixed
---

- When a Workflow run's values are pruned, its run threads keep no name or content of the copies of its files that its agents got: the attachment, file and prepared-document rows go with the bytes, while the messages stay as empty rows and the audit keeps ids, sizes and sha256. Runs pruned before are cleaned on the next pass.
