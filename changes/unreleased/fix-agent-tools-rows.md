---
section: Fixed
---

- Show the Tools section of the agent page as the agreed rows again: one row per package, per own tool of the instance and per Connection, the switched-off ones too, each with its icon, name, sentence, how many of its tools are on and one switch for all of them, mixed while only some are on. The chevron folds out the tools, each with its check box. "This instance" and "Connections" head their rows, "Technical details" stays, and the heading counts the tools that are on, the sum of the rows. The library `Switch` has its mixed state back, and a switch that can be partly on is a tri-state check box to screen readers, so "partly on" is not read as "off"; the `trailing` and `popover` options of `Chip` are gone.
- Give the Connection draft tool `platform.connections.draft_tools` a title, a summary, the group `platform` and an icon, so the agent page no longer shows it by its id.
