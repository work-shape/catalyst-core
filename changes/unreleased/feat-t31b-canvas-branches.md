---
section: Added
---

- **Workflows:** The Workflow canvas draws a `parallel` block as a frame with its branches side by side and a join after them, and a `condition` as a fork with its paths; a chain of else-conditions is one fork with one exit per path. Each branch shows its last run's status and duration, and a parallel frame shows its step counts.
- **Workflows:** A run's page has a timeline that plays the run back moment by moment: a bar per step and per branch shows which branches ran at the same time and how long each took, and the canvas shows the run as it stood at that moment.
- **UI:** `Timeline` shows bars on one time axis with an optional cursor; flow groups take `lanes` and a `joinLabel`.
