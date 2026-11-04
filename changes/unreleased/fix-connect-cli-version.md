---
section: Fixed
---

- **Connect a local agent:** The page names the CLI released with this platform version, not an older one that no longer works against the instance. `PUBLISHED_CLI_VERSION` is set by `pnpm release:cut` to the version it cuts, and `pnpm release:check` and a unit test fail when it differs from the CLI package's version, so the two cannot drift. The release still publishes the CLI first.
