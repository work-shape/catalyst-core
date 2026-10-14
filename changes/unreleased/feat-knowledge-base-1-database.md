---
section: Database
---

- **Knowledge Bases:** Migration `0082_knowledge_base_states` adds the table of a Knowledge
  Base's last check. Rollback: the previous release ignores the new table and drops an agent's
  `knowledgeBases` when it reads the agent, so its agents answer without them.
