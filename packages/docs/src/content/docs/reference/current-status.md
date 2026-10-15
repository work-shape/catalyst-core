---
title: What the release contains
description: What the current release contains.
---

Workshape Catalyst is an early product: configuration keys and package APIs can still change between releases.

## In The Current Release

The open platform contains:

- the chat API under `/api/v1` with streamed agent runs, described by an OpenAPI document, see the [API reference](/reference/api/)
- the standalone chat interface and an embeddable chat widget, with session tokens issued by a host backend
- agents and skills as config assets in the database, edited in Studio or synchronized with the `catalyst` CLI; skills may carry files of any type, and a few skills ship with the platform
- Pages an agent builds in a conversation, and Apps saved from them, with a draft whose changing actions are simulated, **Run live once**, and publishing (module `apps`)
- Workflows with a canvas, test runs, schedules, code steps and a list of runs, acting as a service principal (module `workflows`)
- Connections to remote MCP servers, created in Studio or in release config, with a key entered on the Connection's page (module `connections`)
- Data Stores: one Postgres database per store for Apps and Workflows (module `dataStores`)
- custom code tools through the tool SDK, and capabilities through the capability SDK
- data sources with guarded, read-only Postgres query tools
- generated views, web search and web fetch
- standalone sign-in, service principals with API keys, personal API keys and `catalyst login` (module `personalApiKeys`), roles, individual rights, Namespaces and grants
- retention for conversations and audit events, minimized audit events, usage records with budgets and a customer rate card, and rate limits
- modules, mail for invitations and password reset, and the background jobs page
- execution workspaces with a sandboxed command runner, off unless an instance enables them
- approval requests for skill changes that an agent proposes, and for calls the operation policy holds, decided in the Inbox
- guardrails that check saves, operation calls, publishes and approval requests: the operator's floor in release config, and further guardrails written as assets, tested, dry-run and published with the CLI; Studio > Guardrails lists them read-only with their hits
- the chat dock, which keeps a conversation open beside any page
- Docker images, Compose files, an explicit migration step, and the `/health` and `/ready` probes

Document processing, the artifact helper commands for execution workspaces and the private data view are paid capabilities. They are not in the open repository.

Each page of these docs describes the current release unless it says otherwise.
