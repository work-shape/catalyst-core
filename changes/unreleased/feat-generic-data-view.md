---
section: Changed
---

- **Chat:** a tool's display or structured result of a kind the release has no widget for is
  drawn by a generic data view instead of raw JSON. An object shows as labelled values, its keys
  made readable (`due_date` is "Due date"), with nested objects as sections; a list of flat
  objects is a table; a list of plain values is a list. Days and moments read in the reader's
  language. The view is bounded: four levels, 50 rows per list with "and N more", long values
  cut. It shows the data as text, never as markup. `KeyValue` takes `layout="stacked"` for a
  value that is itself a group of values.
