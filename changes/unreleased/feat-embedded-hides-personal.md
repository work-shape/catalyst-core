---
section: Changed
---

- **Embedded chat:** The read of the signed-in person (`GET /api/v1/me`) now carries `embedded: true` when the request is an embedding host's session token, and nothing for the person's own browser session. The chat leaves out what the server refuses such a session instead of showing it and failing on click: "Always allow" on confirmation cards, the Data Store add (the card says where it is done), "Problem an Workshape melden", the person's own agents, account deletion, and the Settings pages for confirmations, Connections and personal keys, and a personal skill's "use in my chats". The page learns no more of the host than before.
