---
section: Fixed
---

- An App action's input schema names a key a parameter does not take, such as `pattern`, with the keys that parameter's type does take, in place of "Invalid input". An agent step's output schema that no binding supports is refused with the field and the key at fault.
- The runner images (the release's `runner` and the platform's `workspace-command-runner`) carry PyYAML 6.0.2, so an agent's workspace command can read and write YAML in Python.
