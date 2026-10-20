---
section: Changed
---

- **Tooling:** The tool runner projects `knowledge.search`, `knowledge.add_files`, the knowledge query tool and `run_agent` through `TOOL_PROJECTIONS`, one file per tool under `tool-execution/src/tool-projections/`, each naming the effect of the operations it calls and what it adds to their answer. The projection of an operation's outcome onto a tool result is `operation-tool-result.ts`, still one exhaustive switch. Calls answer as before.
