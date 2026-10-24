---
section: Fixed
---

- **Knowledge Bases:** Turning `semantic` on for a Knowledge Base that already holds passages now embeds them. The publish states the passages, estimated tokens, cost and room first and starts only with that statement's confirmation (`confirmProcessing`, CLI `--confirm`), as a change of the embedding model does. Search answers by words and titles until every passage has its vector. Where an index of the same model is left from before `semantic` was turned off, only the passages it lacks are embedded. Turning it on over no passage asks nothing. `knowledge_bases.reindex` (`catalyst knowledge-base reindex`) also embeds a Knowledge Base that searches by meaning but has passages and no index yet.
- **Studio:** A new Knowledge Base of documents searches by meaning and by words where the instance names a default embedding binding (`knowledge.defaultEmbeddingBinding`), and by words alone where it names none. Its page says which. The instance config the interface reads carries `knowledge.semanticSearch`.
