---
section: Added
---

- **Knowledge Bases on a Data Store (module `knowledge`, off by default, needs `dataStores`):**
  the asset kind `knowledge_base` with a draft and a published revision. Its definition names
  a Data Store under `backend: { dataStore: <id> }` and describes at least one of its tables
  with a sentence; it answers the method `structured` alone. A field of a later slice
  (`sources`, `indexing`, `search`, `queries`, `filters`, a built-in or external backend, or
  any field it does not know, such as an answer prompt) is refused with the slice that brings
  it. Publishing needs `knowledge_base.publish` and `data_store.read` on the store, and checks
  that every described table can be read; otherwise it is refused with the reason
  `knowledge_base_needs_attention` and the tables it could not read. `knowledge.<id>.query`
  (`POST /api/v1/knowledge-bases/:knowledgeBase/query`) runs one read-only statement with bound
  parameters under the store's timeout, row and byte caps, with the asker's
  `knowledge_base.use` and no right on the store. It connects as a login role of the Knowledge
  Base's own (`catalyst_kb_…`, password in the Secret Store, member of no role), which may
  select from exactly the tables the published revision describes: publishing grants them and
  takes the rest away in one transaction, "Check now" sets them again, and deleting the
  Knowledge Base drops the role. A store that has a Knowledge Base takes EXECUTE on its
  functions from PUBLIC and keeps it for its app role, also for a function a later migration
  makes; every call is one recorded Operation
  Run, and the audit holds no SQL, parameter or row. `knowledge_bases.get` reads the last
  check and `knowledge_bases.check` runs it again. An agent lists Knowledge Bases under
  `knowledgeBases`; however many it lists, it gets one tool, `knowledge.query`, whose
  description names each published one with its tables. Saving an agent that lists a
  Knowledge Base the instance does not have is refused. In Studio, Build > Knowledge bases adds
  one, describes the tables, shows the last check with "Check now" and a test query, and
  publishes the draft; the agent page has a Knowledge section. **Operators:** add
  `knowledgeBases` to `administration.configAssets.editableAgentFields` where people should
  change it in Studio.
