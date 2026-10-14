---
section: Added
---

- **Tools people can read on the agent page:** the Tools section works like the Skills section
  above it. Each package ("Paket") the agent uses is a chip with its icon and name: Documents,
  Web, Files and code, Results, Skills or Platform. So is each of this instance's own tools and
  each Connection. A chip shows "1/3" while only some of its tools are on and has a remove ×.
  Clicking it opens a panel with its sentence and its tools, each with title and summary, plus
  "Remove package" and "All on". "Add packages" is a picker that lists what is not in use, with
  its sentence and number of tools, and adds it with all its tools on. A tool without a title
  shows its id. `read_skill` shows as included while the agent has a skill and is saved with it,
  so the warning to tick it is gone. The ids, effects and packages stand under "Technical
  details". The Connection groups are gone; each Connection is a chip.
- **What a tool tells people:** a tool definition takes optional `title` and `summary` in
  English and German, a `group` and an `icon` of the UI library's registry. Every platform tool
  carries them; a deployment's tool carries its own. `platform.references.get` answers them as
  `tools` beside `enabledToolNames`, with the module whose switch governs each tool.
- **`Chip` takes a count and a panel:** `trailing` shows small muted text after the label, and
  `popover` makes the chip open a panel under it.
