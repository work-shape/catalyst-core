---
section: Fixed
---

- **Knowledge Bases:** `knowledge.maxPagesPerDocument` accepts values above 5,000. The default remains 500 and the value must be a positive integer. Documents that exceed the limit show the configured value in English and German. No migration is required. Before rolling back, lower any value above 5,000: an older release refuses that configuration at startup. Retry a failed document after raising the limit and restarting the API and knowledge extraction worker.
