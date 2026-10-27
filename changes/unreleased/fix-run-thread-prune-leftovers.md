---
section: Fixed
---

- **Workflows:** Pruning a run's values now also clears answers and comments that were missed. The run's own step calls lose a changing call's answer. Decider comments are removed from every call and request of the run, including the comment on a declined call. That holds for a call running at prune time and for a request approved but not yet carried out. A call approved before the prune and run after it is carried out as usual but stores no answer, and neither does a request decided after the prune. Such a request also loses its error message and the input of its call, and no decision message is added to the pruned thread. Who decided, when and the outcome stay. Without attachment handlers, file copies in a run thread are removed along with their records when their bytes are in the files store. Retention version 4 cleans up runs pruned earlier.
