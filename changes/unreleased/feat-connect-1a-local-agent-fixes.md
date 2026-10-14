---
section: Fixed
---

- **CLI:** `catalyst <kind> validate --from <folder>` reads what `put` reads. For a kind whose
  revisions hold files, such as an App, it checks the folder against the limits of one write and
  says that the instance checks the files as it writes them.
- **CLI:** the commands of one asset, such as `catalyst skill put`, address the workspace a
  working copy is bound to, as its `config` commands do; `--workspace` still names another.
