---
section: Fixed
---

- **Workflows:** Pruning a run's values now also removes answers and comments from calls made by the run's own steps, and from calls decided after the prune. A changing call's answer, the decider's comment (including the comment on a declined call) and the input of the call's request go, along with the error message of its result. A call approved before the prune and run after it is carried out as usual and stores no answer. Who decided, when and the outcome stay. A pruned run thread gets no new decision message. Without attachment handlers, file copies in a run thread are removed from the files store along with their records. Retention version 4 cleans up runs pruned earlier.
