---
section: Changed
---

- **Connection operations stay inside the instance unless an admin opens them:** an operation
  of a Connection has a fourth exposure, `outside`, which admits the CLI and the platform MCP
  server and nothing else. It is off on every operation, new and stored, and no migration sets
  it. Before, the CLI, an MCP client and a person in the browser passed any non-empty exposure;
  now `cli` and `mcp` need `outside`, and a person outside an App and a schedule reach no
  Connection operation directly (`connection_exposure:<origin>`). Over HTTP only an API
  credential (a personal API key, a service principal's credential or a token exchanged for
  one) gives origin `cli`; a session token an embedding host issued is the person (`user`).
  The Connection page has the check box **Outside clients (CLI, MCP)**, German **Externe
  Clients (CLI, MCP)**, on each operation of a Connection made on the instance; release config
  names `outside` in `exposure`. A personal connection refuses every exposure but `agent`.
