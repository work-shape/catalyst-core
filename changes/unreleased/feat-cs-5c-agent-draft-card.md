---
section: Added
---

- **The agent drafts a REST API's tools as a card (CS-5c):** the platform tool `platform.connections.draft_tools` checks the operations an agent declares for an `http_api` Connection as a save would (GET only, the effect `reading`, no header or query or path parameter that can carry a credential, no `.` or `..` path segment in any spelling) and answers every issue, or the draft. The conversation shows the draft as a card with the tools' names; its button "Review and approve" opens the approval list on the Connection's page, or, for an id no Connection has, the New connection dialog filled with the name, address and header names, whose drafted tools wait in the list after "Connect". The card never carries a key, and nothing is saved before the person approves. An agent holds the tool where its definition lists it; "Draft with Workshaper" now asks for the card instead of YAML to paste.
