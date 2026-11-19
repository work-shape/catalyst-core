---
section: Changed
---

- **Chat:** the Knowledge Base sources under an answer stand in one row "Quellen", one chip per
  document with its cited pages merged ("S. 7, 79"), side by side instead of one per line. The
  chip names the file without its extension, with underscores as spaces, and shortens a long
  name; a click opens the first cited page. Its menu names the file whole with its "Stand" or
  "abgerufen" date, opens each cited page, and opens the original ("In Dropbox öffnen", else the
  host), which was a second chip before. Past five documents the row shows four and "+n weitere".
- **UI library:** `Chip` takes a `detail`, a muted text after the label that stays whole while
  the label shortens, and a `trailing` action; `ChipAction` is the round icon button for it,
  usable as the trigger of a menu.
