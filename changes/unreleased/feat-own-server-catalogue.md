---
section: Added
---

- **Connections:** A catalogue entry can name an MCP server a person adds as their own: its
  address (public https on 443), how they sign in (`oauth` or `token`), for a token a short help
  text, a link and the header it goes under, and what it says of the server's tools. The add
  dialog under You > Connections shows the offered entries as tiles above the address field; a
  tile fixes the address, and a token tile goes straight to the token step with its help. The
  card shows the entry's mark while the server's host is the entry's. English and German.
- **Connections:** An entry carries no credential, adds no host to the egress list, grants no
  right and never sets Always allow. Its `changing` starts a tool the server marks read-only as
  changing and unticked; its `reading` never ticks a tool the server does not mark read-only.
  Every rule of a person's own server holds for a server added from an entry.
- **Agents:** The own-server mode of `platform.connections.propose` takes `ownServerEntry`, the
  id of an offered entry, in place of a name and an address; the address is then the entry's.
  An id the instance does not offer is refused with `own_server_entry_unknown`. The tool's
  description lists the offered entries. Its audit names the mode and the entry, never the
  address.
- **API:** `connections.mine` answers `ownServers.entries`, the offered entries, to a person who
  may add a server.
