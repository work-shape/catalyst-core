---
section: Fixed
---

- **Workflows:** On the Workflow canvas, every test in a chain of else-conditions ("Otherwise if: …") is now a row of the fork you can select. It opens that test's own panel and shows its run status and duration. Before, only the first condition could be opened.
- **Workflows:** Durations on the canvas (steps, branches, a parallel frame) are given to the second, as the run's timeline gives them: "1 min 54 s", not "1 min".
- **UI:** A `condition` exit can name a `part` (`FlowExitPart`: id, status, meta). Its row is then selected by that id and shows the part's status and time. `FlowNodeRow` takes `status`, `meta`, `onOpen`, `selected` and `partId`.
