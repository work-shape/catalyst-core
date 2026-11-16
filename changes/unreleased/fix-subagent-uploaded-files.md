---
section: Fixed
---

- **Subagents:** a subagent can now work with the files attached to its chat. It is given the
  chat's list of attached files with its task, as the agent that started it reads them, and
  `read_document`, `view_document_page`, `document.extract_structured` and
  `workspace.import_files` find those files from the subagent's thread; before, they answered
  that the file was not available. A file of another chat is still not found. `run_agent` now
  tells the agent to name the files a subagent needs in its task and to have each subagent
  write its files under `/workspace/agents/<a short name for its task>/`, so subagents that run
  at the same time do not overwrite each other's files.
