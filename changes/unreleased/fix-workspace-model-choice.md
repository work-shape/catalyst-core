---
section: Changed
---

- **Agent models:** whoever may write an agent a workspace owns picks its models without
  `agent_models.manage`: the default binding, the bindings its users may pick and the reasoning
  effort of each (`modelBindingId`, `userSelectableModelBindingIds`, `reasoningEffort`,
  `modelReasoningEfforts`), among the bindings the workspace allows. Those are the list among its
  build limits, or every binding of the instance where the workspace sets none. Before, this held
  only for `modelBindingId` and only in a workspace with a list. Studio offers the same choice.
  `fastMode`, `useModelFallback` and every model setting of an instance-owned agent still need
  `agent_models.manage`, and which bindings a workspace allows stays an instance admin's setting.
