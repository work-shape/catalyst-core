---
section: Changed
---

- **`catalyst config push` writes what has no conflict:** an asset that changed on the instance
  since the last pull (another revision, a delete, a moved agent draft, another asset under the
  name, or one created there since) no longer stops the whole push. The push writes every other
  changed asset and skips that one without writing it, so a change the working copy has not seen
  is still never written over or deleted. A changed default agent is skipped the same way. After
  the push the CLI lists each skipped asset with who changed it and when, prints the scoped
  `catalyst config pull --only` that reads them, and exits with 1. The instance still checks every
  revision under its own lock; where it refuses a batch for changed assets, the CLI sends it again
  without them.
