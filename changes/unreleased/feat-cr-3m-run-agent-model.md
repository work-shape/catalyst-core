---
section: Added
---

- **Subagents:** `run_agent` takes a `model`. A subagent runs on a model the person may pick on
  its agent, narrowed by the model list of the workspace that owns that agent; any other model
  answers `model_not_available`. Without `model` it runs on the parent's model and effort, and
  its usage records the model it ran on. The tool's agents and models are now generated for
  each run from the live config and the person's rights, as lists the model picks from, in a
  stable order so the prompt cache holds; the server still checks every call. An agent's
  `subagentNames: "*"` makes every agent the person may use a subagent of it, and counts as a
  widening in the publish review. The card of a subagent and its row in the Resources panel
  name its agent by display name and its model by label ("Alpha · Small 5.5 · 8 s").
