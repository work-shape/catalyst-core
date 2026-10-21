---
title: Actions on a Connection
description: How an App calls one operation of a Connection through a connection action file, which operations it may call, and the shape of the answer, among it an MCP tool's result.
---

Part of [Build an App](/apps/build/). What every action shares, its input, drafts and publishing: [App actions](/apps/actions/).

## Try the operations first

Build from what the operations really answer, not from their descriptions. Before you write the first action on a Connection:

1. Give yourself its tools. Call `platform.connections.offer_to_agent` with the Connection's id and, as `agent`, the id of the agent you are; where you do not know your id, leave `agent` out and ask the person to pick the agent they are talking to. The person picks and confirms on the card, and the tools the Connection offers to agents are yours from their next message. Never send the person to the agent's page in Studio to add the tools by hand.
2. Call each reading operation the App will use once, with input a person would pass, and look at the answer: where the data is, what its fields are called, how a list and an empty result look. Do not call a changing operation to try it; its answer is described by the operation and tried in the App's draft.
3. Write the actions, the mapping and the App's code against those answers.

Where the person may not change an agent, or does not want to, read the operation's declared input and output with `platform.assets.get` on the Connection, and say that the App is built from descriptions and may need a fix once it runs.

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

For an MCP Connection, the answer's `result` is the MCP tool's result: `{ content, structuredContent }`, where `content` is a list of blocks such as `{ type: "text", text }` and `structuredContent` is there when the tool gives one. A tool that answers an error rejects the call.

Many MCP tools give no `structuredContent` and return their data as JSON text in the first block, `content[0].text`. The App then parses that text itself. Read the data once in one place, preferring `structuredContent`:

```ts
import type { AppCallResult } from "@work-shape/catalyst-app-kit";

/** The data of an MCP tool's answer: its structured content, or the JSON in its first text block. */
function dataOf(answer: AppCallResult): unknown {
  const result = "result" in answer ? answer.result : undefined;
  if (typeof result !== "object" || result === null) return undefined;
  if ("structuredContent" in result && result.structuredContent) return result.structuredContent;
  const first =
    "content" in result && Array.isArray(result.content) ? result.content[0] : undefined;
  const text = first?.type === "text" ? first.text : undefined;
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text; // a tool that answers prose, not JSON
  }
}
```

Which of the two a tool gives, and the fields inside, is what trying the operation showed. A Connection of another kind answers its operation's output as the operation declares it.
