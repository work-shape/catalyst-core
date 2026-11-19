---
section: Changed
---

- **Studio, Connection page:** the page leads with one line of what the Connection does,
  "Connects your agents to …". Under it stands its one state with the one action that fixes it:
  the sign-in of a Connection that signs in, else its key and its test. Then "What agents may do
  with it": each operation by its name, whether it reads or changes, and its switch; a row says
  its status only while it is not ready. What an operation calls and takes, who else may call it
  and Remove wait under **Details** in its row. One line, "Used by …", names what uses it.
  Everything else is folded under **Settings**: name and description, the test of a Connection
  that signs in, the people, the test credential, address and access, person context, used by,
  available in and who may use it. A setting without a name in words, and a value that is a
  structure, stand under Technical details there and no longer as raw keys and JSON on the page.
  The outline is gone, and the head of a Connection that signs in no longer says "Not tested"
  beside its sign-in, nor does its test under Settings while it is signed in. What needs a person
  stands above the operations: why a signed-in Connection fails, with the test; that the test
  credential no longer fits; and the link an admin sends to IT for a Connection each person
  signs in to. The tools a server names stay under the operations. The provider, the client and
  the permissions of a shared sign-in stand under the one Technical details, in Settings, and
  "since" says the moment to the minute.
- **Studio, New connection:** the Connector types with a name come first. An MCP server and a
  REST API wait under one line, "Your own connection (for developers)", which stands open only
  where the instance offers nothing else.
- **UI library:** a `Disclosure` takes its look from its own variant. A bare one folded inside a
  `row` one no longer stretches across the column.
