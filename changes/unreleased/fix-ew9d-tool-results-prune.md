---
section: Fixed
---

- When a Workflow run's values are pruned, its run threads keep no answer of a changing tool call, no input or sign-in context of a settled approval or confirmation, and no comment of who decided: the Operation Runs and requests stay for their audit age with ids, status, hashes, counts, who decided and when. A copy of a run's file that no attachment handler removed, as where none is configured, keeps its object key, size and sha256 but no name or prepared metadata. Runs pruned before are cleaned on the next pass.
