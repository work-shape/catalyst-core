---
section: Added
---

- Studio imports a skill from a folder or a .zip, as public skill libraries ship one ("Import skill" on the Skills list). The browser unpacks it: one top folder is stripped, `__MACOSX/`, `.DS_Store`, `.git/` and the CLI's state files are skipped, links are refused, and sizes are checked before and while inflating (8 MiB per skill, 2 MiB per file, 500 files). A preview shows the name, title, description and every file with its size; an address that is taken offers to replace that skill's files instead.
- A skill's page offers "Replace from folder": the files added, changed (by SHA-256) and removed are listed before the save, which writes the whole folder at the page's revision and files an approval request where a save does.
- `@work-shape/catalyst-ui` adds `FileDropZone`, and `FilePicker` chooses a folder with `directory`.
