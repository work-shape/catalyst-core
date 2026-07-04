---
title: Custom Code Tools
description: Write source-controlled tools that run inside a client instance.
---

Custom code tools are the primary extension point for a Vivd Catalyst client instance.

A tool lets the agent do a bounded action: look up a record, create a ticket, fetch a document, send a draft to review, or call an internal service.

For larger reusable behavior, author a capability package with `@vivd-catalyst/capability-sdk`. Capabilities can contribute tools, attachment handlers, managed object readers, and lifecycle cleanup while consuming platform-owned services such as the datasource registry and Managed Object Access.

## Configured Tool Shape

Use the public tool SDK and product-owned types. Prefer configured tool factories when customer-specific values should live in release config.

```ts
import { defineConfiguredTool, defineTool } from "@vivd-catalyst/tool-sdk";
import { z } from "zod";

export const lookupTicketToolFactory = defineConfiguredTool({
  name: "support.lookup_ticket",
  configSchema: z.object({
    permissionRef: z.string().min(1).default("support-ticket-reader"),
  }),
  create(config) {
    return defineTool({
      name: "support.lookup_ticket",
      description: "Look up a support ticket by its public ticket id.",
      inputSchema: z.object({
        ticketId: z.string().min(1),
      }),
      outputSchema: z.object({
        status: z.string(),
        summary: z.string(),
      }),
      permission: {
        mode: "allow",
        requiredPermissionRefs: [config.permissionRef],
      },
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
  },
});
```

Plain `defineTool(...)` exports are still useful for tests or fixed tools that do not need release-config parameters.

## Client Assembly Registration

Register tool factories explicitly in `src/client.ts`.

```ts
import { defineClientInstance } from "@vivd-catalyst/client-assembly";
import { createEscalationToolFactory } from "../tools/create-escalation";
import { lookupTicketToolFactory } from "../tools/lookup-ticket";

export default defineClientInstance({
  rootDir: new URL("..", import.meta.url),
  tools: [lookupTicketToolFactory, createEscalationToolFactory],
});
```

Agents reference stable tool names in release config. They do not reference file paths.

```yaml
tools:
  - name: support.lookup_ticket
    enabled: true
    config:
      permissionRef: support-ticket-reader
  - name: support.create_escalation
    enabled: true

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

Use `output` for data the model should see in later agent-visible history.

Use `privateOutput` for data the platform may store, hydrate, or render but must never send to the model.

Use `display` for typed UI outputs.

Built-in HTML displays provide Tailwind CSS, Lucide icons, external HTTPS chart scripts, and
runtime theme variables inside the rendered iframe. For model-authored or private hydrated
HTML, use Tailwind utility classes and Lucide markers such as
`<i data-lucide="chart-column"></i>` instead of bundling those libraries into every result.
For canvas or Chart.js rendering, read colors from `window.vivdCatalystTheme.chartColors()`
or CSS variables such as `var(--foreground)`, `var(--border)`, and `var(--primary)`.
Do not hard-code white cards, gray/slate text, fixed dark backgrounds, or `!important`
color overrides unless a color is genuinely data-semantic.

By default, `show_view` allows external HTTPS script URLs so common charting CDNs can load.
A client instance can tighten this with `show_view.config.allowedScriptSrc: []` or a specific
list of HTTPS origins/paths, while `["*"]` keeps the default all-HTTPS script behavior.
The tool owns the rendered CSP and strips model-supplied CSP tags; `connect-src` and external
image loading remain blocked.

When `display` needs a polished visual treatment, register a client-owned widget for the
returned `display.kind`. Concrete widgets belong in `clients/*/widgets` for reference
clients or in deployment-owned code for customer assemblies. Platform packages only provide
the generic widget registry, tool frame, and fallback rendering.

Use `auditSummary` for minimized governance metadata, not raw sensitive payloads.

Do not pass broad database handles or global service containers into tools. Give tools explicit capabilities and scoped secrets.

For configured customer/domain databases, prefer platform `dataSources` and the OSS datasource registry. If a datasource enables `tools.query`, the platform exposes a guarded `data.<source>.query` tool. Restricted visualization packages can use the same registry without owning SQL execution, secret resolution, or read-only guardrails.

For byte-backed files or artifacts, use the Capability SDK's Managed Object Access rather than passing storage object keys through capability workflows. The platform owns managed file/artifact metadata; a capability may provide a byte-store adapter and object-key adapter when its storage layout is capability-specific.

## Permission Policy

Every tool should have an explicit permission expectation:

- safe read-only metadata lookup
- sensitive read
- write action
- external communication
- destructive action

For v1, avoid enabling approval-required tools until runtime resume is implemented end to end. Write the policy now, but do not deploy a configuration that can only pause and fail.
