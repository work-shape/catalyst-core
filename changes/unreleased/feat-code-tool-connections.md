---
section: Added
---

- **Code tools call Connections (TOOL-2c):** a code tool lists in `connections` the
  `connection.<name>.<operation>` operations its handler may call; a write naming one that does
  not exist is refused. The handler calls one through `catalyst_tool` (Python) or `catalyst-tool`
  (Node), over a request channel on the container's own streams: the sandbox keeps no network and
  never holds the credential. The platform makes the call as the tool's caller, with their rights
  (`connection.use`), as an Operation Run of its own whose origin is the tool's call; an
  undeclared operation is refused with `connection_not_declared`, and one call makes at most 50
  requests of at most 256 KiB, read one at a time. The policy of the declared operations is the
  floor of the tool's call, asked once before the handler starts, and an `approval` asked of a
  personal Connection's operation refuses the tool's call. Nothing inside the handler waits: a
  call the policy asks more of than it asked when the tool's call was admitted or as the
  handler started, or one a guardrail asks about, is refused with `connection_call_waits`. A handler that stopped after it called a
  Connection is not run again; its call fails as `interrupted`. In a draft agent's Try the calls
  reach the Connection's test credential. A run so allowed records the decision reason
  `tool_call`.
