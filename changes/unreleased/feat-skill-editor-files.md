---
section: Added
---

- The skill editor in Studio shows the skill as a folder: `SKILL.md`, and the files below `references/`, `scripts/` and `assets/`. Text files are edited in place; any file can be uploaded, replaced, downloaded and deleted. A file is added to one of the three folders, and its type is read from its name. A save writes the whole folder where a file beside the instructions changed, and the instance's refusals, such as a file over 2 MiB, a compiled program or a script that is not UTF-8 text, are shown with the path of the file.
- A write of a skill's config is checked as a write of its folder is: the text resources it holds, beside the files it keeps, are refused for their size, the number and total size of the files, a Git LFS pointer, an invalid path, and a path that is a file and a folder at once. Before, a config write took such resources unchecked.
- The UI library has `FilePicker`: a labelled library control, such as a button or a menu item, opens the system file dialog, and the library owns the hidden file input.
