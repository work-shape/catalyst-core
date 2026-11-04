---
section: Changed
---

- **An agent knows its own name:** Every agent is told the name people see it by (its display name, in the person's language) at the start of a run; a Workflow step's agent is not. Workshaper's shipped instructions name no fixed name, so an admin who renames it on its agent page gets an agent that calls itself by that name, and its instructions stay as shipped so each release still updates them. A rename survives a release.
- **Connections:** The REST API choice "Draft with Workshaper" is now "Draft with the agent" ("Mit dem Agenten entwerfen"), since the chat beside the page may hold any agent.
