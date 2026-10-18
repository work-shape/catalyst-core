---
section: Fixed
---

- Make `catalyst skill pull` refuse unbound folders before walking their contents, reject non-skill commands before contacting an instance, reject dot path segments and targets containing the process working directory, clean up new parent folders on failure, and ignore only `.DS_Store` metadata during refresh and staging. Help lists the skill pull command once.
- Keep `catalyst init` quiet about an existing `@AGENTS.md` import and recognize the same instance by URL origin, including host case and default ports.
