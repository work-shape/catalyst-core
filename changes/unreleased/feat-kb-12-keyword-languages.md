---
section: Added
---

- **Knowledge Bases:** a Knowledge Base lists its keyword languages in `indexing.languages` (`da`, `de`, `en`, `es`, `fi`, `fr`, `it`, `nl`, `no`, `pt`, `sv`), set on its page under Advanced. Its store builds one full-text column and one GIN index for each listed language, and keyword search reads only those. One that lists none keeps German and English, as before. A published change rebuilds the columns in the background through the re-index job, with no embedding call: new columns are filled in batches and indexed concurrently, and search keeps answering from the old ones until one short transaction switches. The store of a Knowledge Base gets migration 18 (`keyword_languages`), which every store applies at its next start. It turns the German and English columns from generated columns into columns a trigger fills, keeping their values and rewriting nothing.
