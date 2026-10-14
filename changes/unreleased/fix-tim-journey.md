---
section: Fixed
---

- **A new API key starts with no scope ticked:** You > API keys and a CLI's connect code no
  longer tick every right the person holds. A click on the scope a person wanted used to take it
  away, so the key came out with every other scope. The key gets exactly the boxes ticked.
- **`catalyst <kind> put` and `validate` take what `show --json` printed:** the definition is
  read from its `config`. The whole answer was sent as the definition before, so an unchanged
  agent read as a changed model and an admin was refused with "Missing the right
  'agent_models.manage'". The right is still asked where the model settings change, leaving a
  model binding out included.
- **Docs and agent orientation on Connections:** the docs name the interface's navigation,
  Studio > Connections and Studio > Guardrails (German: Studio › Verbindungen), and Studio's page
  walks through connecting a remote MCP server with the rights each step needs. They and the
  orientation every agent reads say that MCP is the only connector type, with no HTTP
  connector, and that a Connection's key is entered on its page, never in a chat.
