---
title: Initialize a working copy
description: Bind a new working copy to a Catalyst instance.
---

## Initialize a working copy

```sh
catalyst init --instance <url> --dir <root>
```

This offline command needs no key. It creates `catalyst.yaml` bound to the instance, adds or updates a marked Catalyst block in `AGENTS.md`, and writes `@AGENTS.md` to `CLAUDE.md` where that file is absent. Existing prose outside the block and an existing `CLAUDE.md` stay unchanged. A different instance binding is refused with exit code 2. It installs no skills, hooks or tool settings. Run `catalyst context --json`, then pull, edit, validate, diff and push.
