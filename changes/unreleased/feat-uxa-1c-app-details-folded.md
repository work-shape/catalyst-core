---
section: Changed
---

- **App drafts fold Files and Actions under "Technical details":** an App's draft page opens
  with its preview and one line, "Technical details" ("Technische Details"), after the Preview
  tab. One click shows the Files and Actions tabs; the browser remembers the choice for the next
  draft and after a reload. Folding them again returns to the preview. The UI library's
  `TabsList` takes an `end` beside the tabs, and `TabsDisclosure` is the line that shows more.
