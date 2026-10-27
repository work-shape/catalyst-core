---
section: Fixed
---

- A Workflow run that an operation step or an agent step's tool started keeps the run behind that call, and every continuation of it keeps it too. A credential-published child is no longer started or continued past a closed starter just because the run continued as new, which drops the start call, or because the start call was pruned by age. Runs opened before this change find their starter through their first history's start call, as long as that call is kept. A run whose starter cannot be read counts as closed.
