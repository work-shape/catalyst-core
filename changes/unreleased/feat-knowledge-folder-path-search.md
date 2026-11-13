---
section: Added
---

- **Knowledge Bases:** Keyword search reads the folder path of a synced or Workflow-fed
  document: the words of its path count as words of each of its passages, so a query naming a
  folder ("Heizung Projekt Nord") finds the passages of the files filed under it, and a query of
  only a folder's name finds its files. Only documents whose path holds a word of the query are
  read for it. The embedded text is unchanged, so no Knowledge Base is embedded again; search by
  meaning alone does not read the path.
- **Knowledge Bases:** Every search passage of a synced or Workflow-fed document carries `path`,
  its path below the source's boundary with folders and file name, which the agent can cite and
  pass to a `path` filter. A file added by hand has none. The path appears in no Operation Run or
  audit event.
- **Knowledge Bases:** A declared `prefix` filter ignores case and the Unicode encoding of an
  umlaut, so `/projekte/süd/` matches `/Projekte/Süd/`. `eq` still compares exactly.
