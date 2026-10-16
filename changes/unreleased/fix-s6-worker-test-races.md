---
section: Fixed
---

- **Tests:** Stop workspace workers before removing their directories, observe queued commands and held workflow steps, and await the refused message’s own audit event. Exercise the command give-up boundary with only Date frozen.

The workflow outcome-wait probe holds the second operation note, proving the worker has waited before checking the running state. It fails explicitly if the worker finishes without waiting.
