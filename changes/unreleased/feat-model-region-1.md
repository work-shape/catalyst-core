---
section: Added
---

- **Personal Connections:** Require every model route of the run to declare `region: eu`. Missing or non-EU regions fail before credential resolution with `personal_connection_region` and a plain explanation instead of a Connect card. Model provider regions accept optional short strings in release config.
- Held operation calls keep their run's model routes and check them again after confirmation or approval, before resolving credentials. Missing stored routes fail closed for personal Connections.
