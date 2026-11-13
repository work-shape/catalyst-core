---
section: Added
---

- **Knowledge Bases:** Keyword search reads the folder path of a synced or Workflow-fed
  document: the words of its path count as words of each of its passages, so a query naming a
  folder ("Heizung Projekt Nord") finds the passages of the files filed under it, and a query of
  only a folder's name finds its files. The documents are picked by the query's words that are
  no stop word of a keyword language and no bare number, and only the 50 whose paths hold the
  most of them are read for it, so a folder name every path holds never makes a search read
  every passage. File extensions and bare numbers are no words of a path. The embedded text is
  unchanged, so no Knowledge Base is embedded again; search by meaning alone does not read the
  path, and a store not yet at migration 21 searches its passages as before.
- **Knowledge Bases:** Every search passage of a synced or Workflow-fed document carries `path`,
  its path below the source's boundary with folders and file name, which the agent can cite and
  pass to a `path` filter. A file added by hand has none. The path appears in no Operation Run or
  audit event.
- **Knowledge Bases:** A declared `prefix` filter on `path` ignores case and the Unicode encoding
  of an umlaut, so `/projekte/süd/` matches `/Projekte/Süd/`. A prefix on another field and `eq`
  still compare exactly.
