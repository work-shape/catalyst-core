---
section: Fixed
---

- **Agent configuration (SA-0):** stored agents naming unavailable tools, skills or models no longer stop instance startup. Missing tools and skills are omitted at runtime; an agent with an unavailable primary model is excluded from chat rather than silently switching models. Startup warns once per affected agent, and agent reads report unavailable references and their reasons without changing the stored definition. New and changed agent definitions remain strictly validated.
