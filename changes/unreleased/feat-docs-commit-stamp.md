---
section: Added
---

- The docs build writes `catalyst/commit.json`, `{"commit": "<platform sha>"}`, so the published site names the commit it was built from. The hand-over check compares it with main. The commit is `CATALYST_PLATFORM_COMMIT` when set (a build without Git metadata), else the HEAD of the platform checkout; a build in neither case skips the file with a warning.
