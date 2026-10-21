---
title: Actions on a Connection
description: How an App calls one operation of a Connection through a connection action file, which operations it may call, and the shape of the answer, among it an MCP tool's result.
---

Part of [Build an App](/apps/build/). What every action shares, its input, drafts and publishing: [App actions](/apps/actions/).

## A `connection` action

```yaml
connection: accounting_source
operation: list_bookings
effect: reading
description: The bookings of one client in one month.
input:
  schema:
    type: object
    properties:
      client: { type: string, maxLength: 40 }
      month: { type: string, description: "The month as YYYY-MM" }
    required: [client]
  mapping:
    clientId: "{{client}}"
    period: "{{month}}"
```

- `connection` is the Connection's name, which `connections` in `app.yaml` lists.
- `operation` is the name of one operation of that Connection, exactly as the Connection lists it. For an MCP Connection that is the name of the server's tool. Only an operation an editor accepted on the Connection's page, enabled and offered to Apps (exposure `bridge`), can be called. `platform.assets.operations` with `for: app` lists the operations an App may call, as far as the person may use them, each named `connection.<connection>.<operation>` with its effect: write the two parts as `connection` and `operation`. `platform.assets.get` on the Connection shows all its accepted operations with name, effect and exposure, where the person may read the Connection. Without these tools, ask the person for the operation's name.
- `effect` is `reading` or `changing`, as the operation was accepted. A `reading` action that stands for a changing operation is refused.
- `input.schema` and `input.mapping`: see [the input of an action file](/apps/actions/#the-input-of-an-action-file). The mapping makes the operation's input.

## The answer

The answer's `result` is the MCP tool's result: `{ content, structuredContent }`, where `content` is a list of blocks such as `{ type: "text", text }` and `structuredContent` is there when the tool gives one. A tool that answers an error rejects the call.
