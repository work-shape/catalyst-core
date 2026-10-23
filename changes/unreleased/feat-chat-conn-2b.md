---
section: Added
---

- **Chat:** A Connect card in chat. When an agent proposes a catalogue entry or an OAuth Connection, or a call of a personal Connection is refused because the person has not signed in or must sign in again, the conversation's owner sees "<Service> verbinden" with one button. Connect signs in through a popup (or a new tab where popups are blocked) and then sends "<Service> ist verbunden" as the person, so the agent carries on.
- **Chat:** A Connection that is not set up offers Einrichten to people who may write Connections, and anyone who may not set it up or use it is asked to contact their administration.
- **Agents:** The agent reads such a refusal as `connection_not_connected` or `connection_needs_reconnect` with one sentence telling it to wait for the person. Refused tool results carry a host-only `connect` field with the Connection's name, title, service, catalogue link and the refused agent, never an account or a token; the person's word goes to that agent.
