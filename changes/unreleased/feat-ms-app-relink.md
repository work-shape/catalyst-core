---
section: Added
---

- **Connections:** A Connection on a managed OAuth client that was installed from an earlier version of its catalogue entry is refused every change with `catalogue_update_required`, since it keeps the settings of the entry's current version only. Its page offers the update to the current version: it writes that version's settings and link and keeps the tools as they are. People stay signed in where the new version keeps the endpoints and base address, and connect again where it moves one. Every write is still held to the entry's settings exactly.
- **Connections:** The page of a Connection where each person signs in with their own account says that each person connects, in chat or under Settings, instead of "Not configured" and a key to enter, also right after it is installed or saved. On the operator's managed OAuth client it says the instance brings the app registration. The list says the same.
