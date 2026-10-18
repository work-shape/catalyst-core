---
section: Fixed
---

- Workflow runs exclude time spent waiting for a run linked by run key from `limits.duration`, including waiting ancestors. The linked run keeps its own duration budget.
- A keyed link to the calling run, its ancestors, or a run already waiting on it is refused with `run_key_cycle`: “The key for Workflow '<workflow>' is held by a run in its own call chain”. No run key or input value is exposed. Rolling back removes this guard and restores counting keyed waits toward duration.
- Concurrent keyed links serialize per client instance before taking run row locks, so simultaneous links cannot close a wait cycle or deadlock each other. Unkeyed child creation does not take this lock.
