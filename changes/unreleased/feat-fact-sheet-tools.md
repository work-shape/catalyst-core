---
section: Changed
---

- The Results tools on the agent page say what they do: **Keep a fact sheet** ("Faktenblatt führen"), **Read the fact sheet** ("Faktenblatt lesen") and **Reopen an earlier result** ("Früheres Ergebnis öffnen"). Where the instance offers both, keeping the fact sheet and reading it are one check box: on, the agent holds `structured_data.publish` and `structured_data.read`; off, neither. An agent stored with only one of them is saved as its box shows on its next save from the page, also when only another field changed: with both when it held `structured_data.publish`, with neither when it held only `structured_data.read`. Where the instance offers only `structured_data.publish`, it stands alone as before. The tool names are unchanged.
- The chat steps of these tools follow the same names: **Update the fact sheet** ("Faktenblatt aktualisieren"), **Read the fact sheet** ("Faktenblatt lesen") and **Reopen an earlier result** ("Früheres Ergebnis öffnen").
