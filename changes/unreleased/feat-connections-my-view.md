---
section: Changed
---

- Studio > Connections opens on "My connections" for every member: one card per connection they use with their own account, saying "Connected as …" with Disconnect or one Connect button, and which agents work with it. A service a member can connect themselves shows "Connect", not "Set up".
- Whoever may manage Connections gets a second tab, "Manage": the Connections of the instance with "One shared access" or "Each person's own account" and how many people are connected, the services that can be installed, and other people's servers. Members without that right see only their own connections and the ones their organisation set up.
- A Knowledge Base source shows the service's mark and name, the Connection it syncs through, linked for who may open it, and its folders as paths.
- `GET /api/v1/me/connections` names, for each personal Connection, the service it is for (`serviceTitle`, `mark`) and the agents that use it (`usedBy`). A Connection's list summary carries `serviceTitle` and `serviceColor` or `serviceLogo` where it was installed for a catalogued service.
