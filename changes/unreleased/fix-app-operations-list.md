---
section: Fixed
---

- **The agent can list what an App may call:** `platform.assets.operations` takes `for: app`
  and then lists the operations of Connections exposed to Apps (`bridge`), named
  `connection.<connection>.<operation>`, as far as the person may use them. Without `for` it
  lists, as before, what a step of a Workflow may call. An operation exposed to Apps alone was
  listed nowhere, so an agent writing a `connection` action had to guess its name. The list is
  of the instance and no longer needs the conversation to be about an asset, so it answers
  while the agent builds a Page.
- **Data stores page:** the description and the empty list say that a data store is created
  through the CLI or the API by a person with the right to create one. They said an agent
  creates one, which no agent tool does.
