---
section: Changed
---

- **Release checks:** the deployment release gate reuses successful full hosted checks at both pinned platform and capabilities commits, while still building packages and checking the deployment assembly. Missing CI evidence runs both full checks; `--full` always forces them.
