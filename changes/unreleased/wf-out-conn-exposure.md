---
section: Fixed
---

- A run an outside client started asks every Connection call of its steps, an agent step's included, whether the operation is still exposed to `outside`, also when an approved or waiting call runs: a Connection whose admin took `outside` back after the start is no longer called. Refused with `connection_exposure:outside`.
- The `outside_not_exposed` refusal of a publish names only the Connections the publisher may read or use and counts the others, so a child Workflow's Connections stay hidden from a publisher who may not see them.
- An outside client that reads a run no outside client started no longer sees the Connection the run failed at: the failure of the run and of its steps keeps its code and drops the Connection, its title, a Connection operation and the sentence that named it.
