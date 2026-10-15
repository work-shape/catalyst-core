---
section: Changed
---

- **The head of every asset page names the asset and says what it does:** the name, then its
  description or summary on the same row. The asset's id is no longer shown on the page; "Copy
  ID" ("ID kopieren") in the head's "…" menu puts it on the clipboard, on Studio pages, Apps
  (for whoever builds them) and Workflows (for whoever may change them). The App details dialog
  no longer lists the id.
- **Long names wrap, then cut:** a name in an asset's head, a Studio list row or an App, agent or
  Workflow card takes a second line, is then cut and reads whole on hover, also beside the dock
  at 1280 and at 390.
- **No id as a row's second line, one scope chip per row:** Data Store and Knowledge Base rows
  show their description instead of their id, an App card no longer shows its id to builders,
  and a Connection or Data Store row shows one chip for whose it is ("Persönlich" alone for the
  reader's own) instead of a second "Arbeitsbereich"/"Instanz" chip.
- UI library: `PageHeader`'s detail name and `ListRow`'s title wrap to two lines, `CardTitle`
  takes `clamp`, and `DropdownMenuCopyItem` copies a text and says so in place.

- Header actions stay within the screen at phone widths, including the German Workflow
  header: the shared header wraps them so its Copy ID menu stays reachable.
