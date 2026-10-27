---
section: Fixed
---

- **Workflows:** Config saves preserve comments, blank lines and existing key order in `workflow.yaml`, including edits from the canvas and agent tools. If the YAML edit cannot reproduce the sent manifest exactly, the save uses a full render and logs a fallback without content.
