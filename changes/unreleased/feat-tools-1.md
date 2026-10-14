---
section: Added
---

- **Tools people can read on the agent page:** the instance's tools stand by package
  (Documents, Web, Files and code, Results, Skills, Platform, and this instance's own tools),
  each group with its icon, one sentence and a switch for all its tools, mixed while only some
  are on. Its tools are folded below, each with its title and summary; a tool without a title
  shows its id. `read_skill` shows as included while the agent has a skill and is saved with it,
  so the warning to tick it is gone. The ids, effects and packages stand under "Technical
  details".
- **What a tool tells people:** a tool definition takes optional `title` and `summary` in
  English and German, a `group` and an `icon` of the UI library's registry. Every platform tool
  carries them; a deployment's tool carries its own. `platform.references.get` answers them as
  `tools` beside `enabledToolNames`, with the module whose switch governs each tool.
- **A mixed state for `Switch`:** `mixed` rests the thumb in the middle and turns everything on
  with one press.
