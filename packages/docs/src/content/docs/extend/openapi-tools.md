---
title: OpenAPI API Tools
description: Expose selected external API operations as agent tools.
---

OpenAPI API tools let an instance expose selected operations from an existing customer or third-party API.

The backing API runs outside Vivd Stage. Vivd Stage validates and calls selected operations through a tool adapter.

## When To Use OpenAPI Tools

Use an OpenAPI API tool when:

- the backing system already has a stable HTTP API
- the operation can be described clearly to the model
- input and output schemas are explicit
- authentication can be scoped safely
- the operation can be allowlisted

Use a custom code tool instead when:

- the workflow needs custom orchestration across systems
- the source API is not described well enough
- the operation needs special audit summaries
- the tool must transform or minimize sensitive output before the model sees it

## Selection, Not Import Everything

Do not expose an entire API spec as tools.

Select the operations an agent is allowed to call:

```yaml
tools:
  openapi:
    support-api:
      specFile: ./integrations/support-api.openapi.yaml
      auth:
        mode: serverCredential
        secretRef: support-api-token
      operations:
        - operationId: getTicket
          toolName: support.get_ticket
          permission: sensitive_read
        - operationId: createEscalation
          toolName: support.create_escalation
          permission: write
```

## Required Controls

For each operation, document:

- what the model-facing description says
- what user permissions are required
- which auth credential is used
- whether output is returned to the model
- whether output is shown in the UI
- what audit event is recorded
- expected rate limits and timeout behavior

The agent should never get implicit access to every operation in a customer API.
