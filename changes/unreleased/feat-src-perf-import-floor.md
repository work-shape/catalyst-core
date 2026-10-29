---
section: Changed
---

- **Knowledge Bases:** a source import is several times faster. 10,000 items go from publish to `indexed` in under two minutes on a 16-core machine (twelve minutes before), and an import of 100,000 items takes no more than 25 percent longer per item. A fetch batch claims and adopts its items in groups instead of one at a time, the listing of a page writes it in a few statements, index jobs run up to 32 side by side on a worker (64 across workers, from 4), those that end together release their originals together, and a job that frees a slot is replaced at once instead of at the next poll. The cleanup of copies a fetch left behind runs once per five minutes and Knowledge Base, not once per batch. `release_originals` jobs are no longer queued for a content an index job will release.
- **Jobs:** a worker starts the next job as soon as a slot frees, not at its next one-second poll.
- **Testing:** `pnpm probe:knowledge-import` runs the import probe on demand: the seconds to `indexed`, the machine's CPU count, the profile per stage, and that a killed and resumed worker leaves no duplicate row.
