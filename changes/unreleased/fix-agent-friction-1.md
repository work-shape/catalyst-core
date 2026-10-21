---
section: Fixed
---

- An App action's input schema names a key a parameter does not take, such as `pattern`, with the keys that parameter's type does take, in place of "Invalid input". An agent step's output schema that no binding supports is refused with the field and the key at fault.
- The runner images (the release's `runner` and the platform's `workspace-command-runner`) carry PyYAML 6.0.2, so an agent's workspace command can read and write YAML in Python.
- Kit 1.7.0: a call made when the interface that shows the App never answered rejects with `not_connected`, which is no longer retryable, and its message says the fault is the page around the App's and that trying again inside the App does not help. A new App names kit 1.7.0; Apps on older kits keep theirs.
