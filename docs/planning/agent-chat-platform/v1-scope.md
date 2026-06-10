# V1 Scope

## Include

V1 should include:

- embeddable chat UI
- standalone chat UI for local testing, direct access, and control-plane routes
- separate Node API service as the dedicated client backend
- auth adapter with development auth and customer-backed token auth
- persisted user-scoped conversation history with configurable retention
- local in-instance agent runtime
- custom code tools through the tool execution interface
- Postgres for conversations, messages, audit events, config snapshots, user identity mappings, and retention state
- model provider adapter for enterprise, region-controllable chat/document models such as Azure OpenAI, OpenAI, or Vertex AI
- schema-first HTTP API
- API contract package shared by server validation and API client
- config files for agents, tools, and basic UI settings
- typed UI extension points for domain outputs, especially document analysis panels/tool-result renderers
- basic control-plane/governance surface for config visibility, retention status, audit views, deletion workflows, and sensitive admin actions
- superadmin panel for budgeted model cost, model usage, configured pricing, spend budget, usage safeguards, recent usage events, and audit metadata
- minimized audit event layer with a product-owned event schema/recorder for auth, conversations, tools, documents, config, deletion, and admin actions
- model usage event layer for provider, model, token counts when reported by the provider, and correlation metadata
- configurable pricing, spend budget, cost safety multiplier, and late usage safeguards for model calls and model tokens in release config
- client branding and theme config for customer name, logo, and colors
- startup validation that proves release-config tool references are implemented and enabled consistently
- document processing interfaces for Markdown conversion and structured extraction
- Docker images for runtime services
- Docker Compose for local development
- first production deployment path using Docker Compose on a VPS/VM

## First Vertical Slice

V1 is the full first product version, not the first implementation milestone. The first build should be a smaller vertical slice that proves the spine end to end before broadening the platform.

Recommended order:

1. Standalone chat with development auth.
2. Node API with persisted user-scoped conversations in Postgres.
3. Local agent runtime using the model provider adapter.
4. One custom code tool defined through the tool SDK and exposed through the tool registry.
5. Tool execution through the worker-compatible interface, with in-process execution allowed only as an adapter for local development or trusted internal tools.
6. Minimal audit/trace events for auth, conversation creation, message completion, and tool execution.
7. Model usage tracking and superadmin usage visibility.
8. API contract package consumed by server validation and the API client.
9. Startup validation for config/tool implementation closure.
10. Customer-backed token auth.
11. Embeddable widget reusing the same chat core.
12. Domain UI output for the first document analysis workflow.

This sequencing keeps the architecture reusable while avoiding early work on extension surfaces that have not yet been exercised by a real workflow.

Apply the "less is more" rule throughout v1 as a UX and API design principle: hide complexity behind strong defaults and expose only the fields, settings, packages, UI controls, and extension points the workflow truly needs. Do not remove security, retention, authorization, auditability, or testability to make the code smaller.

## Exclude But Prepare For

V1 should exclude, but architecturally prepare for:

- vector retrieval implementation
- isolated agent worker machines
- direct URL/file fetch capability for linked documents
- browser automation / browser-use
- broad autonomous web scraping
- Kubernetes or managed container orchestration
- MCP tools
- broader UI plugin/slot system and headless SDK

## Exclude And Do Not Prepare For

V1 should exclude and not prepare for:

- managed multi-tenant SaaS

## V2 Preparation Rule

When v1 prepares for a v2 capability, it means interface-only preparation: product-owned contracts, package boundaries, and config shapes where useful. It does not mean half-implemented features, hidden runtime behavior, or premature operational dependencies.

## Dependency Policy

Dependency choices should start from current stable versions at implementation time. Do not intentionally begin with old major versions unless there is a concrete compatibility reason. Avoid beta/RC dependencies unless the reason is explicit.
