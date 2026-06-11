---
title: Overview
description: How Vivd Stage is meant to be used by teams configuring their own agent chat.
---

Vivd Stage gives an organization a dedicated agent chat instance without asking that organization to fork the platform.

The platform provides the reusable pieces:

- chat API and streaming path
- standalone and embedded chat surfaces
- auth adapter boundary
- agent runtime boundary
- tool execution boundary
- release config validation
- conversation storage
- usage governance
- minimized audit events

The customer-specific layer provides the narrow pieces:

- agent instructions
- enabled tools
- custom code tools
- OpenAPI tool selections
- branding and chat copy
- retention and usage policy
- auth integration settings
- deployment wiring

## Who This Is For

These docs are for instance operators and technical teams who want a chat agent for their company, internal process, product, community, or other endeavor.

Some teams will run the infrastructure themselves. Others will only provide the instance brief, config, tools, and integration details while someone else operates the dedicated instance. Both paths use the same product model.

## What You Should Not Do

Do not copy platform internals into your client instance.

Do not add runtime-only tools by mutating a live server.

Do not put customer-specific prompts, labels, examples, or tool behavior into platform packages.

Do not treat audit logs as full transcripts. Audit events should be minimized governance metadata.

## How Work Flows

```text
instance brief
  -> release config
  -> custom tools and integrations
  -> client assembly validation
  -> build and deploy
  -> governed chat use
```

This keeps behavior explainable: a running instance can be traced back to source-controlled config, tool code, and platform package versions.
