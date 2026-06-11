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
    server.ts
    tool-registry.ts
    config.ts
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

The server imports platform packages, loads release config, registers tools, validates the assembly, and starts the chat API.

```ts
import { createChatServer } from "@vivd-stage/chat-server";
import { loadClientConfig } from "./config";
import { tools } from "./tool-registry";

const config = await loadClientConfig();

const server = await createChatServer({
  config,
  tools,
});

await server.listen({ host: "0.0.0.0", port: 4100 });
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
