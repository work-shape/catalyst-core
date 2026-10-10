---
title: Custom Code Tools
description: Write source-controlled tools that run inside a client instance.
---

Custom code tools are the primary extension point for a Workshape Catalyst client instance.

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

Use `display` for transient typed UI outputs. For a keyed domain result that should also appear
as a current, revisioned conversation resource, return `structuredResult` instead:

```ts
return toolSuccess(
  { key: "review", message: "Review replaced." },
  {
    structuredResult: {
      key: "review",
      kind: "support.review",
      schemaVersion: 1,
      title: "Support review",
      data: review,
    },
  },
);
```

The platform derives the typed side-panel display from this single payload and exposes its current
revision through `structured_result.read`. The resource is projected from immutable tool history;
domain tools remain responsible for validating and replacing their complete result. The first valid
publication fixes the `kind` for a key. A later same-key publication with another `kind` remains in
the immutable message history but is ignored by the current-resource projection, rather than
silently reinterpreting the resource. Publications are resolved by message creation time and then
their persisted insertion ordinal, so equal timestamps still produce a deterministic revision and
snapshot.

Built-in HTML displays provide Tailwind CSS, Lucide icons, and runtime theme variables inside
the rendered iframe. For ordinary model-authored HTML, use Tailwind utility classes and Lucide
markers such as `<i data-lucide="chart-column"></i>` instead of bundling those libraries into
every result. For canvas rendering, read colors from `window.vivdCatalystTheme.chartColors()`
or CSS variables such as `var(--foreground)`, `var(--border)`, and `var(--primary)`.
Do not hard-code white cards, gray/slate text, fixed dark backgrounds, or `!important`
color overrides unless a color is genuinely data-semantic.

A view loads Tailwind CSS and Lucide from the instance itself, in pinned versions served
under `/app-runtime/view/<version>/`, and no script file from anywhere else. A reverse proxy in
front of the instance must route `/app-runtime/*` to the API. To let views load scripts from
other hosts, for example a charting library, name each host in the instance config:

```yaml
views:
  allowedScriptSrc:
    - https://cdn.jsdelivr.net
```

Entries are HTTPS origins or paths; `"*"` allows every HTTPS host. The default is an empty
list. The list is release config and applies when a view is shown, so it also governs views
saved earlier: a view may load from a host once it is named and no longer after it is removed.
A view that asks for a script from another host is shown without that script. The tool stores
only the model's HTML with any CSP tag stripped; the interface composes the content policy
when it shows the view, and `connect-src` and external image loading remain blocked.

Every view is framed in a shell document the instance serves under
`/app-runtime/view-shell/<version>/`. Its policy keeps a view from moving its own frame to
another address, and the view's bootstrap takes the address from every link. Do not put
links into a view. [What A View Can Reach](/configure/release-config/#what-a-view-can-reach)
states the guarantee and its limits.

Private hydrated views get no library and no script host, whatever `views.allowedScriptSrc`
says, and they are static: no script runs in them, because a script can send packets to
another host over WebRTC and no browser lets a document forbid that. The tool places the rows
in the template as HTML-escaped text where `{{ROWS_JSON}}` or `{{DATA_JSON}}` stands, or at
the end. When the view is shown, the interface writes its body anew from an allowlist of
elements and attributes: text, headings, lists, tables, inline formatting, inline styles
without `url(`, embedded images and plain inline SVG. Links lose their address, and scripts,
forms, frames, `link` and `meta` elements are left out. The frame of such a view has a fixed
height and scrolls inside.

When `display` needs a polished visual treatment, register a client-owned widget for the
returned `display.kind`. Concrete widgets belong in `clients/*/widgets` for reference
clients or in deployment-owned code for customer assemblies. Platform packages only provide
the generic widget registry, tool frame, and fallback rendering.

Use `auditSummary` for minimized governance metadata, not raw sensitive payloads.

Do not pass broad database handles or global service containers into tools. Give tools explicit capabilities and scoped secrets.

For configured customer/domain databases, prefer platform `dataSources` and the OSS datasource registry. If a datasource enables `tools.query`, the platform exposes guarded `data.<source>.query` and `data.<source>.describe` tools. The description tool lists readable relations or returns columns and key relationships for one relation, so an agent can discover unfamiliar schemas without hand-writing catalog queries. Restricted visualization packages can use the same registry without owning SQL execution, secret resolution, or read-only guardrails.

For byte-backed files or artifacts, use the Capability SDK's Managed Object Access rather than passing storage object keys through capability workflows. The platform owns managed file/artifact metadata; a capability may provide a byte-store adapter and object-key adapter when its storage layout is capability-specific.

## Permission Policy

Every tool should have an explicit permission expectation:

- safe read-only metadata lookup
- sensitive read
- write action
- external communication
- destructive action

A tool declares `permission.mode` as `allow`, `deny` or `approval_required`. This release runs the first two. It cannot pause an agent run for a person's decision and continue it afterwards, so an instance with an enabled `approval_required` tool does not start: startup validation names the tool. The API reference lists the operation `conversations.runs.command` for continuing a waiting run; in this release it answers `CONFLICT`.

What a person can approve today is a skill change. An agent with the tool `propose_skill_change` files an approval request and its run goes on without waiting; the change applies when a reviewer approves it, see [Agent skill changes](/configure/config-assets/#agent-skill-changes). `skill_change` is the only kind of approval request in this release.
