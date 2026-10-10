---
title: Current Status
description: What the current release contains and what it does not contain yet.
---

Workshape Catalyst is an early product: configuration keys and package APIs can still change between releases.

## In The Current Release

The open platform contains:

- the chat API under `/api/v1` with streamed agent runs, described by an OpenAPI document, see the [API reference](/reference/api/)
- the standalone chat interface and an embeddable chat widget, with session tokens issued by a host backend
- agents and skills as config assets in the database, edited in the interface or synchronized with the `catalyst` CLI
- custom code tools through the tool SDK, and capabilities through the capability SDK
- data sources with guarded, read-only Postgres query tools
- generated views, web search and web fetch
- standalone sign-in, service principals with API keys, roles, individual rights, Namespaces and grants
- retention for conversations and audit events, minimized audit events, usage records with budgets and a customer rate card, and rate limits
- modules, mail for invitations and password reset, and the background jobs page
- execution workspaces with a sandboxed command runner, off unless an instance enables them
- approval requests for skill changes that an agent proposes, with optional model-evaluated approval checks
- Docker images, Compose files, an explicit migration step, and the `/health` and `/ready` probes

Document processing, the artifact helper commands for execution workspaces and the private data view are paid capabilities. They are not in the open repository.

## Not In The Current Release

- OpenAPI API tools. [OpenAPI API Tools](/extend/openapi-tools/) describes the intended shape; the tool adapter is not built.
- Tools with the permission mode `approval_required`. An agent run cannot pause for a person's decision and continue afterwards, so startup refuses such a tool.
- The operation policy value `approval`. Nothing files and decides the approval yet, so a call under it is refused, see [Operation policy](/configure/release-config/#operation-policy).
- Editing a sent message and exporting a conversation.

Each page of these docs describes the current release unless it says otherwise.
