# Data Chat

Data Chat is the current working title for a reusable AI agent chat platform for sensitive customer workflows. The context language focuses on the product and domain concepts, not implementation details.

## Language

**Customer**:
An organization that uses the agent chat platform for its own internal users and domain workflows.
_Avoid_: Client, account

**User**:
A person authenticated by a customer application who is allowed to interact with the chat.
_Avoid_: End user, employee

**Authenticated User**:
The product-owned user identity resolved by an auth adapter for one request.
_Avoid_: Customer session, browser user

**User Identity Mapping**:
A persisted link between a product-owned user and one auth-source-specific external user id, such as a standalone login id or a customer application user id. New identities may auto-attach to an existing user via an unambiguous verified-email match (`auth.identityLinking.byVerifiedEmail`); the mapping record stays the durable key.
_Avoid_: Email match as account key, duplicate account

**Client Instance**:
A separately deployed product instance for one customer, with its own infrastructure and operational boundary.
_Avoid_: Tenant, workspace, account

**Agent Chat Platform**:
The reusable product foundation that provides embeddable chat, agent execution, tool integration, configuration, and operational controls.
_Avoid_: Starter kit, template

**Client Branding**:
Customer-specific presentation metadata for a client instance, including customer name, logo, and theme colors.
_Avoid_: White-labeling, skin

**Agent**:
A configured AI behavior with instructions, model settings, available tools, and optional knowledge sources.
_Avoid_: Bot, assistant

**Agent Runtime**:
The product boundary that starts, continues, observes, and cancels agent work without assuming one concrete execution backend.
_Avoid_: Agent framework, agent library

**Execution Runtime**:
A concrete environment that performs agent work, such as an in-process chat loop, background worker, isolated machine, or coding-agent machine.
_Avoid_: Worker, runner

**Agent Worker**:
An execution runtime that runs a whole agent process or long-running agent task.
_Avoid_: Tool worker, background job

**Tool Worker**:
An execution runtime that runs one tool call or a narrow tool execution job.
_Avoid_: Agent worker, plugin runtime

**Tool Execution**:
The product boundary for executing one validated tool call with caller context, deadlines, cancellation, and auditable output.
_Avoid_: Agent runtime, tool adapter

**Tool Registry**:
The mapping between stable tool names and executable tool implementations, including the metadata needed to expose them safely to agents.
_Avoid_: Plugin database, runtime catalog

**Code-Deployed Model**:
A deployment model where source-controlled code and configuration are built or released into a client instance.
_Avoid_: Manual instance mutation, runtime registration

**V2 Preparation**:
Interface-only preparation for a future capability through product-owned contracts, package boundaries, or config shapes, without implementing runtime behavior in v1.
_Avoid_: Half implementation, hidden feature

**Platform Package**:
A reusable package owned by the product foundation and imported by client instances.
_Avoid_: Starter code, copied template

**Client Code**:
Customer-specific source code and configuration that assembles a client instance using platform packages.
_Avoid_: Forked platform, tenant customization

**Client Assembly App**:
The TypeScript application that imports platform packages, registers client tools, loads client configuration, and builds the deployable client-specific server image.
_Avoid_: Starter app, generated app

**Client Assembly Validation**:
Startup validation that proves a client assembly app's code, release config, tool implementations, and agent tool references form a consistent deployable client instance.
_Avoid_: Runtime registration, dynamic plugin discovery

**Agent Capability**:
A permissioned group of tools or runtime behaviors made available to an agent for a class of work, such as file fetching, document processing, retrieval, or browser automation.
_Avoid_: Tool, feature

**File Acquisition**:
The process of turning an uploaded file, email attachment, or URL into a managed file stored by the client instance.
_Avoid_: Web scraping, document extraction

**Managed File**:
A file stored under platform control after upload, handoff, or acquisition, identified by a file id and governed by authorization, audit, and retention policy.
_Avoid_: Browser file object, raw attachment, local path

**Document Processing**:
The process of converting, extracting, comparing, or redacting document content after a file has been acquired.
_Avoid_: File acquisition, retrieval

**Document Text Extraction**:
A document processing action that converts a managed file into readable text or Markdown for agent use, without interpreting fields, comparing facts, or making workflow judgments.
_Avoid_: Document analysis, OCR, retrieval

**Browser Automation**:
The use of a real browser environment to navigate pages, click controls, submit forms, or download files when simple HTTP fetching is insufficient.
_Avoid_: Web scraping, URL fetch

**OpenAPI API Tool**:
A tool generated or configured from an OpenAPI-described operation whose backing API runs outside the product.
_Avoid_: Custom code tool, external API tool

**Tool Adapter**:
The product layer that normalizes different tool sources into a common callable interface for agents.
_Avoid_: Tool wrapper, connector

**Knowledge Source**:
Customer-approved data that an agent may retrieve from while answering or acting.
_Avoid_: Knowledge base, context store

**Knowledge Source Access**:
An explicit grant in agent configuration that allows an agent to retrieve from a named knowledge source.
_Avoid_: Implicit retrieval, global knowledge

**Retrieval**:
The act of finding relevant information from knowledge sources, vector stores, files, or structured customer data for use by an agent or tool.
_Avoid_: Search, RAG

**Retrieval Adapter**:
A storage-specific implementation that lets the platform ingest, search, filter, and reference knowledge source content without coupling agents to one vector provider.
_Avoid_: Vector store, search client

**Conversation**:
A persisted chat history owned by an authenticated user and retained according to the client instance's retention policy.
_Avoid_: Session, chat session

**Conversation Workflow**:
The product module that owns user-scoped conversation access, retention-aware creation/deletion, chat-turn persistence, agent-run observation, and conversation/message audit outcomes.
_Avoid_: Conversation route, message handler

**Conversation Retention**:
The configured policy and deletion behavior for persisted conversations, messages, tool call records, and related outputs.
_Avoid_: Log retention, backup retention

**Data Deletion**:
A product workflow that removes or expires conversations, messages, tool outputs, document outputs, and related file references according to policy or a valid request.
_Avoid_: Retention, database cleanup

**Audit Event**:
A minimized record of a security, governance, data, tool, config, or lifecycle action.
_Avoid_: Application log, full transcript

**Model Usage Event**:
A minimized record of one model provider call, including provider, model, token counts when reported, and correlation metadata.
_Avoid_: Billing log, full prompt log

**Usage Budget**:
A release-config policy that caps conservative estimated model spend for a client instance over a defined period, using configured pricing and a safety multiplier.
_Avoid_: Provider invoice, exact billing record

**Usage Safeguard**:
A late-catching release-config policy that caps model calls or model tokens for a client instance over a defined period.
_Avoid_: Provider rate limit, spend budget

**Usage Governance**:
The product module that enforces usage budgets and safeguards, serializes v1 model-call accounting, and produces minimized usage summaries for governance views.
_Avoid_: Billing service, analytics tracker

**Audit Retention**:
The configured retention policy for audit events, separate from conversation retention.
_Avoid_: Conversation retention, backup retention

**Embed Surface**:
The customer-facing integration point that renders the chat inside a customer application.
_Avoid_: Widget, script tag

**API Contract**:
The schema-first HTTP request and response contract consumed by the chat backend and generated or generated-assisted API clients.
_Avoid_: API client, route implementation

**Standalone Chat UI**:
A first-party full-page chat surface used for local development, testing, demos, or non-embedded deployments.
_Avoid_: Embedded widget, admin UI

**Control Plane**:
The settings and governance surface for a client instance, including configuration visibility, retention status, audit views, and deletion workflows.
_Avoid_: Standalone chat UI, admin-only app

**Superadmin Panel**:
The control-plane view restricted to superadmins for sensitive governance state such as usage, audit, retention, and deletion operations.
_Avoid_: Admin dashboard, analytics app

**User Administration**:
A superadmin control-plane workflow for viewing product-owned users, editing their roles and permissions, and managing optional user identity mappings.
_Avoid_: Auth provider console, password administration

**Governance Action**:
A permissioned action that exposes or changes sensitive operational state, such as viewing audit status, changing retention policy, exporting data, or deleting user data.
_Avoid_: Normal chat action, application log

**Governance Role**:
A role that permits sensitive operational actions such as viewing audit status, managing retention, or deleting user data.
_Avoid_: User role, tool permission

**Chat Session Token**:
A short-lived token accepted by the chat backend to identify an authenticated user and their permissions for a client instance.
_Avoid_: Customer session, API key

**Auth Adapter**:
The product seam that resolves an incoming request or token into an authenticated user and authorization context.
_Avoid_: Auth provider, login system

**Instance Operator**:
The party responsible for running a client instance, either us or the customer.
_Avoid_: Deployment profile, tenant operator

**Customer-Hosted Integration**:
A customer system, API, MCP server, or data source that a client instance calls but does not operate.
_Avoid_: Hybrid deployment, external tenant

**Custom Code Tool**:
A tool implemented with customer-specific code that runs inside the client instance or one of its execution runtimes.
_Avoid_: OpenAPI API tool, uploaded code, extension

**UI Slot**:
A deliberate frontend extension point where a customer-specific widget or component can be inserted without replacing the whole chat UI.
_Avoid_: Arbitrary UI customization, frontend plugin

**Domain UI Output**:
A typed UI surface that renders structured workflow output, such as a document analysis panel or tool-result renderer.
_Avoid_: UI plugin, arbitrary widget

**Operated Dedicated Instance**:
A client instance hosted and maintained by us on separate infrastructure for one customer.
_Avoid_: Managed SaaS, hosted tenant
