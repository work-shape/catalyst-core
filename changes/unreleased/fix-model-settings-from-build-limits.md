---
section: Fixed
---

- **Agents:** A save refused for changing model settings without `agent_models.manage` now says
  what to do instead of only "Missing the right": which settings it changes, their stored
  values to keep (or to leave out of a new agent, which then runs the instance's default
  model), and that an instance admin makes the change or grants the right; for an agent of the
  instance, that an agent a workspace owns takes its models from whoever writes it. A refusal from a workspace's build limits
  (`model_not_allowed`, `model_binding_required`) names the model bindings the list allows,
  also as `allowedModelBindingIds` in its details.
