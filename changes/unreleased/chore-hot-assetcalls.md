---
section: Changed
---

- **Tooling:** The agent's asset calls are one file per family (`server/src/platform/asset-calls/`: subject, put, app-save, skill, discovery) over one shared scope; the asset tools are one file per tool (`tool-execution/src/platform-asset-tools/`), each with its part of the port, and the late binding forwards every method without a hand-kept table; the platform orientation is one file per paragraph (`client-assembly/src/orientation/`). Tool definitions, the orientation text and every call's behaviour are unchanged.
