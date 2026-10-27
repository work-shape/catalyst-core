---
section: Fixed
---

- A Workflow run that an operation step or an agent step's tool started now keeps the run behind that call, including the platform's `workflows.start` operation, and every continuation keeps it too. Before, a credential-published child could be started or continued past a closed starter in two cases: after the run continued as new, which drops the start call, or after the start call was pruned by age. A run opened before this change reads its starter from its first history's start call once more at its next continuation, while that call is still kept, and passes it on. When retention has cleared a starter's own definition, the starter is read from the revision it names. A starter that cannot be read counts as closed.
