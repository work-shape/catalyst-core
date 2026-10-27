---
section: Fixed
---

- Only a person signed in to Catalyst publishes a Workflow that outside clients (CLI, MCP) can start. A personal API key, a Service Principal's credential or a run that publishes a revision with that switch on is refused with `outside_switch_person_only`, also where the published revision has it on already; a key may still publish the Workflow with the switch off. Before, a key that may publish Workflows could publish a scheduled Workflow copying a Connection's data into a Data Store and an outside one reading that store, and so read data the Connection keeps from outside clients.
