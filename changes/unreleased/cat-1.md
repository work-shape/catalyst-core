---
section: Added
---

- **Connection Catalogue (CAT-1):**
  - A release ships catalogue entries: data about one outside service, each with a `tools` part, a `source` part or both. `loadCatalogueEntries` reads one folder per entry. An assembly passes them as `catalogue`, and release config names the offered ones in `catalogue.entries`.
  - Every shipped entry is checked at start, as the instance would check the Connection it makes. The start stops when an entry is broken, when `catalogue.entries` names an entry the release does not ship, or when a named entry has no part this build can install. Only a named entry's hosts join the egress list.
  - New connection shows the offered entries under "Dienste", with a `ServiceMark`, and greys an entry the operator has not named. A part installs through the form of its Connector type, with the checklist and a sentence on the shared account placed before the secret. A tools part then lists its operations for review, with the reading ones the entry recommends ticked.
  - An entry only recommends. It cannot hold an exposure, enabling, grant or agent. A changing operation is never ticked in advance. The install enables only what the admin approves and grants no right.
  - A Connection keeps a `catalogue` link (`entry`, `part`, `version`). A write that sets or changes the link is refused with `catalogue_entry_not_offered` unless the entry is offered and its part makes a Connection of that type. A link that stays the same, or is removed, is always accepted.
  - `connections.connector_types` answers `entries` beside `types`.
- **UI:** `ServiceMark` in `@work-shape/catalyst-ui` shows a service either by its official logo, supplied and drawn unchanged, or by a white initial on the service's colour. The library holds no vendor's logo.
- **Connections:** A Connector type form's `service` must be a lowercase slug, such as `box`. A type that names it in words is refused when it registers. A typed Connection now stores that `service`.
