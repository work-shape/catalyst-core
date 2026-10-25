---
section: Fixed
---

- **Knowledge Bases:** The publish dialog in Studio now words what a publish processes again in the reader's language. Before, it showed the API's English sentence ("Reprocess N affected contents …") to German readers too. It now reads, for example, "3 Dokumente werden mit den neuen Einstellungen noch einmal gelesen." with the estimated cost in plain words. `assets.get` returns the same count and cost as `publishProcessing` (`count`, `line` and `cost`, which is `none`, an `estimate` with `min`, `max` and `currency`, or `unavailable`), where `line` is the index of the English sentence in `publishQuestion`. The sentence stays in `publishQuestion`, in the publish refusal and in the CLI.
- **Agent tools:** A call of an operation whose work continues after the call now answers `done`, with its run id, when the operation has already ended its run, and answers its failure when the run failed. Before, an agent that confirmed a Workflow source's first import was told `running` for a run that was done. The API already answered this way.
