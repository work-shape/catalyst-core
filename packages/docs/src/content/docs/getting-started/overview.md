---
title: Overview
description: How Workshape Catalyst is meant to be used by teams configuring their own agent chat.
---

Workshape Catalyst gives an organization a dedicated agent chat instance without asking that organization to fork the platform.

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

## First Decisions

Before writing tools or deploying anything, decide:

- who operates the instance
- what the agent is allowed to help with
- which users may access it
- which customer systems and documents it may touch
- what should be retained, audited, deleted, and backed up
- which model provider and region are acceptable

Start with [Operating Models](/getting-started/operating-models/) and then write the [Instance Brief](/operate/instance-brief/).

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
