---
section: Added
---

- **Workflows:** an `agent` step takes an optional `model`, the id of a model binding agents may
  select on the instance, so a step that only sorts or extracts can run on a small model. Without
  it the step runs on the instance's default chat binding, as before. An unknown binding, an
  embedding binding or one marked `agentSelectable: false` is refused at save and at publish with
  `model_not_available`, naming the id. The step's usage is recorded on the binding it ran on.
