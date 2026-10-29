---
section: Added
---

- **Studio:** A "Capabilities" page ("Fähigkeiten") below the kinds in Studio's rail shows what the agents of the instance can be given, one row per package: the general skills and tools first ("General", "Allgemein"), then one row per module, and the instance's own tools last. Each row folds out its skills, its tools and the agents that use them, each agent a link to its page. A module that is off is shown only to a reader who manages users, marked "Not active on this instance, ask Workshape"; nobody else learns of it. Studio's rail now also shows beside a single kind.
- **API:** `platform.capabilities.get` (`GET /api/v1/context/capabilities`) answers the packages, with the agents among those the reader may read, under the same right as the references of the agent page.
