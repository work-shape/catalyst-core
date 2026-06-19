---
title: Client Assembly
description: Keep customer-specific code thin and source-controlled.
---

A client assembly app imports platform packages and wires them to one organization's config, tools, and deployment settings.

It should not copy platform internals.

## Recommended Shape

```text
client-instance/
  package.json
  Dockerfile
  docker-compose.yml
  .env.example
  src/
    client.ts
    server.ts
  agents/
    support-agent.yaml
    instructions/
      support-agent.md
  tools/
    lookup-order.ts
    update-ticket.ts
  config/
    app.yaml
    ui.yaml
    model-providers.yaml
  deploy/
    compose.prod.yaml
    Caddyfile
```

## Assembly Code

The client object imports platform packages, points at release config, registers tool factories, validates the assembly, and starts the chat API.

```ts
import { defineClientInstance } from "@vivd-catalyst/client-assembly";
import { createDocumentProcessingCapability } from "@vivd-catalyst/document-processing";
import { lookupOrderToolFactory } from "../tools/lookup-order";
import { updateTicketToolFactory } from "../tools/update-ticket";

export default defineClientInstance({
  rootDir: new URL("..", import.meta.url),
  capabilities: [createDocumentProcessingCapability()],
  tools: [lookupOrderToolFactory, updateTicketToolFactory]
});
```

```ts
import client from "./client";

await client.listen();
```

Exact APIs may evolve while the platform is still early. The boundary should remain the same: platform packages provide reusable behavior, and the client assembly app provides source-controlled customer choices.

## Startup Validation

The assembly should fail before listening when:

- an agent references a tool that is not registered
- a configured tool is enabled but has no implementation
- a disabled tool appears in an agent allowlist
- an approval-required tool is enabled before runtime resume is implemented
- required auth, model provider, retention, or database settings are missing

Validation is part of the product model. A broken instance should not start and surprise users at runtime.

## What Belongs In The Client Layer

Keep these in the client assembly app:

- customer-specific tools
- agent instructions and suggested prompts
- release config and UI copy
- customer system credentials and scoped secret references
- domain output mappings
- deployment env examples and compose overrides

Keep these in platform packages:

- chat server behavior
- API contracts
- UI primitives and shells
- config schema
- tool SDK and tool execution contracts
- auth adapter contracts
- usage governance
- audit and storage interfaces
- datasource registry, adapters, guardrails, and generic datasource query tools
- capability SDK, managed file, conversation attachment, and managed artifact extension surfaces

Reusable capabilities that are not part of the OSS foundation should live in capability packages. Document processing, for example, owns its preprocessing config under `capabilities.documentProcessing`, its document tools, and its document-specific model-context hints while using platform-managed files and conversation attachments.
