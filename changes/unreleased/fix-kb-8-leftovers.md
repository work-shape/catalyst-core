---
section: Fixed
---

- **Knowledge Bases:** Setting `indexing.embedding.binding` back while a re-index to another model is still building now drops the half-built index. New documents are no longer embedded into it, so nothing more is paid for it. A job of `knowledge_base.reindex` drops it after the publish; a waiting re-index of that model ends without an embedding call.
- **Knowledge Bases:** Turning `semantic` off now drops the Knowledge Base's embeddings, as the spec says. Turning it on again embeds every passage after the confirmed statement, as for a first index.
- **Studio:** A Knowledge Base that searches by meaning, has searchable documents and no index yet, as one published before semantic search embedded existing passages, says so on its page and offers "Embed passages…" ("Passagen einbetten…") to whoever may publish it. The dialog states passages, tokens, cost and room before anything starts.
