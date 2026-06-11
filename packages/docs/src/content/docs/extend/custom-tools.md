---
title: Custom Code Tools
description: Write source-controlled tools that run inside a client instance.
---

Custom code tools are the primary extension point for a Data Chat client instance.

A tool lets the agent do a bounded action: look up a record, create a ticket, fetch a document, send a draft to review, or call an internal service.

## Tool Shape

Use the public tool SDK and product-owned types.

```ts
import { defineTool } from "@agent-chat-platform/tool-sdk";
import { z } from "zod";

export const lookupTicket = defineTool({
  name: "support.lookup_ticket",
  description: "Look up a support ticket by its public ticket id.",
  inputSchema: z.object({
    ticketId: z.string().min(1),
  }),
  outputSchema: z.object({
    status: z.string(),
    summary: z.string(),
  }),
  async execute(input, context) {
    const ticket = await context.secrets
      .get("support-api")
      .then((secret) => fetchTicket(secret, input.ticketId));

    return {
      status: "success",
      output: {
        status: ticket.status,
        summary: ticket.summary,
      },
      auditSummary: {
        message: "Ticket metadata returned to agent.",
      },
    };
  },
});
```

## Tool Registry

Register tools explicitly.

```ts
import { lookupTicket } from "../tools/lookup-ticket";
import { createEscalation } from "../tools/create-escalation";

export const tools = [lookupTicket, createEscalation];
```

Agents reference stable tool names in release config. They do not reference file paths.

```yaml
agents:
  support_agent:
    tools:
      - support.lookup_ticket
      - support.create_escalation
```

## Tool Design Rules

Make tool descriptions concise and model-facing.

Validate inputs with schemas.

Return structured output.

Use `modelSummary` when the full output is too large or sensitive for model context.

Use `domainUi` for typed UI outputs.

Use `auditSummary` for minimized governance metadata, not raw sensitive payloads.

Do not pass broad database handles or global service containers into tools. Give tools explicit capabilities and scoped secrets.

## Permission Policy

Every tool should have an explicit permission expectation:

- safe read-only metadata lookup
- sensitive read
- write action
- external communication
- destructive action

For v1, avoid enabling approval-required tools until runtime resume is implemented end to end. Write the policy now, but do not deploy a configuration that can only pause and fail.
