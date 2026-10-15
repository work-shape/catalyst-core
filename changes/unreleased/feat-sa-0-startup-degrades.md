---
section: Fixed
---

- **Agent configuration (SA-0):** stored agents naming unavailable tools, skills or models no longer stop instance startup. Missing tools and skills are omitted at runtime; an agent with an unavailable primary model is excluded from chat rather than silently switching models. Startup warns once per affected agent, and agent reads report unavailable references and their reasons without changing the stored definition. New and changed agent definitions remain strictly validated.
- **Agent page (SA-0):** a "Not available" line names each tool, skill and model the agent names that the instance lacks, with the reason in plain words, and an agent whose model is missing says it cannot chat until its model is changed. A tool the instance does not have shows as unavailable and removable in the Tools section, as a tool of a module that is off already did. The page reads the agent's `unavailableTools` in place of the deprecated `moduleOffTools`.
