---
section: Added
---

- **A project's Knowledge Bases (PRJ-8):** a project attaches up to 20 Knowledge Bases from its own "Wissensbasen" tile, and every chat in it searches them beside its agent's own. Attaching grants nothing. A project others read attaches only what everyone who reads it may search: the person's own is greyed with the share into the workspace, and one not available in the workspace is greyed with the reason. Each run checks again for the person whose turn it is, so a Knowledge Base a reader of the chat may not search never answers there. One that stops applying stays listed as not applying and is searched in no chat. `projects.setup.get` lists `knowledgeBases` and, where the module `knowledge` is on, `knowledgeBaseChoices`. `projects.setup.set` now changes only the fields a call names: `defaultAgent`, `skills` and `knowledgeBases` are each optional. The audit's `project.setup_changed` counts the Knowledge Bases added and removed.
- **Project page layout:** the page body is now a container its layout can measure, so the files sit beside the chats from 1280 px wide, and the tiles stand side by side as far as there is room.
