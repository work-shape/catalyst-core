# Architecture

The system should be a deployable product core with strict extension points. It is not a shared SaaS platform and not a starter repo that customers fork and drift away from.

```text
Customer application
  -> embed script / iframe / web component / headless SDK
  -> chat API
  -> auth adapter and client instance boundary
  -> agent runtime interface
  -> execution runtime
  -> tool adapter layer
  -> model provider adapter
  -> audit, storage, retrieval, observability
```

## Product Boundaries

- **Client instance**: a separately deployed product instance for one customer, with its own infrastructure and operational boundary.
- **Instance operator**: the party operating a client instance. Initially this is us; later it may be the customer.
- **Customer-hosted integration**: a customer system, API, MCP server, or data source that the client instance calls but does not operate.

Managed multi-tenant SaaS is deliberately out of scope. Another customer means another dedicated client instance and separate infrastructure.

The deployment flow should stay the same regardless of who operates the client instance. We may operate the first instances; a self-hosting customer should use the same images, Compose files, env contract, migrations, and deploy scripts.

## Platform Components

- **Embed surface**: customer-facing integration point, probably starting with a script tag that mounts an iframe or web component.
- **Standalone chat UI**: first-party full-page/local chat surface for testing, development, demos, and non-embedded deployments.
- **Chat API**: backend API used by the widget, standalone UI, and future SDKs.
- **API contract**: schema-first HTTP request/response contract consumed by the server and API client.
- **API client**: generated or generated-assisted frontend client adapter for the schema-first HTTP API.
- **Auth adapter**: turns an incoming request/session token into an authenticated product user with roles, permissions, and audit context.
- **Conversation workflow**: owns user-scoped active conversation access, retention-aware creation/deletion, chat-turn persistence, agent-run observation, and conversation/message audit outcomes.
- **Agent runtime interface**: starts, continues, observes, and cancels agent work.
- **Execution runtime**: concrete backend that performs agent work, such as an in-process chat loop, background worker, or isolated coding-agent machine.
- **Tool execution interface**: executes one validated tool call with caller context, deadlines, cancellation, and audit output.
- **Model provider adapter**: abstracts Azure OpenAI, OpenAI, or other model providers.
- **Usage governance**: owns spend-budget checks, late usage safeguard checks, usage summaries, and serialized v1 model-call accounting for a client instance.
- **Tool adapter layer**: normalizes custom code tools, OpenAPI API tools, built-in platform tools, and future MCP tools.
- **Knowledge adapter layer**: connects document stores, vector search, file search, and customer knowledge sources.
- **Config registry**: stores and validates client-instance configuration.
- **Governance action layer**: centralizes admin/superadmin role checks and audit events for sensitive operational reads or mutations.
- **Audit and observability**: records traceable events without over-retaining sensitive prompts or documents.

## Runtime Granularity

There are two worker boundaries:

- **Agent worker**: runs a whole agent process or long-running task. It owns the plan, model loop, state transitions, and tool-call orchestration.
- **Tool worker**: runs one specific tool call or narrow tool execution job. The main agent runtime remains in control.

For v1, the default agent runtime should run inside the client instance and call custom code through the tool execution interface. Tool execution should be worker-compatible from the start so custom tools can move between in-process execution and a separate worker process/container without changing agents or tool definitions.

In-process tool execution is acceptable for local development and trusted internal tools that we wrote or reviewed. Production custom tools should be runnable in a separate tool worker when performance, timeout control, dependency isolation, secret scoping, or operational safety requires it. The isolation problem is not only malicious code; it is also avoiding broad access to database handles, environment secrets, internal network access, and CPU/memory shared with the chat API.

A future dedicated agent worker machine is a separate execution runtime. It may reuse tool libraries internally, but the product-facing agent runtime interface should treat it as an opaque agent execution backend rather than routing its individual tool calls through the main client instance's tool-worker path.

Isolated agent runtimes are v2. V1 should keep only the `Agent Runtime` interface boundary needed to exchange the local in-instance runtime later.

## V1 Agent Runtime Contract

The v1 `AgentRuntime` contract should be small and product-owned. It should not expose Vercel AI SDK, assistant-ui, model provider, or future isolated-worker types.

Recommended shape:

```ts
interface AgentRuntime {
  start(input: StartAgentRunInput, context: RuntimeCallContext): Promise<AgentRunHandle>;
  observe(runId: AgentRunId, context: RuntimeCallContext): AsyncIterable<AgentRuntimeEvent>;
  resume(runId: AgentRunId, command: AgentRuntimeCommand, context: RuntimeCallContext): Promise<void>;
  cancel(runId: AgentRunId, reason: string | undefined, context: RuntimeCallContext): Promise<void>;
}
```

`start` input should describe the user-facing work, not operational concerns:

```ts
type StartAgentRunInput = {
  agentName: string;
  conversationId: string;
  message: {
    text: string;
    files?: ManagedFileRef[];
  };
};
```

Files should be passed as managed file references, not raw bytes. Upload/acquisition, storage, validation, and retention belong to file/document services before the agent runtime sees the file.

The runtime should resolve the agent's configured tools from release config using `agentName`. Do not pass an ad hoc "allowed tools" list on every run. Tool availability is a property of the agent configuration; tool authorization is checked when the agent attempts to call a tool.

`RuntimeCallContext` should carry request-scoped infrastructure concerns such as authenticated user, cancellation/deadline, and correlation id. Audit recording should be handled by the runtime wrapper, tool execution layer, or injected audit dependency; it should not be part of the agent's semantic input.

Use `observe` rather than `stream` as the interface name. Some runtimes will stream token/message deltas; future isolated runtimes may only emit sparse lifecycle events and a final result. Both should fit the same observation contract.

`resume` exists for interactive runtime commands, especially user approval or denial of a tool call that requires explicit permission. A runtime can emit a `tool_permission_requested` event, pause, and continue after receiving a permission decision.

Minimum v1 event types:

- `message_delta`
- `message_completed`
- `tool_call_started`
- `tool_permission_requested`
- `tool_call_completed`
- `tool_call_failed`
- `run_completed`
- `run_cancelled`
- `run_failed`

The runtime should preserve agent-visible history durably, including assistant tool-call requests, normalized tool inputs, full model-visible tool outputs, and tool errors. The browser stream may choose what to show, but the model-context replay path must be able to reconstruct prior tool calls and results accurately. Context bounding or future compaction should happen only when projecting durable history into a provider request.

`ModelContextProjection` should be a dedicated deep module inside the runtime implementation. It owns the data-critical rules for turning durable agent-visible history into provider messages: excluding `privateOutput` and `display`, replaying tool inputs/results/errors, applying configurable output bounds, inserting future compaction artifacts, and adapting to provider-specific message formats. Keep the agentic loop itself internal to the local runtime adapter unless a second runtime implementation makes a broader seam real.

## V1 Tool Definition And Execution Contract

The v1 tool contract should follow the common pattern used by OpenCode, LangChain, Mastra, Vercel AI SDK, and OpenAI Agents SDK:

- stable tool name
- concise model-facing description
- input schema
- optional output schema
- hidden runtime context
- permission policy before execution
- structured result/error envelope

Tool definition:

```ts
type ToolDefinition<Input, Output> = {
  name: string;
  description: string;
  inputSchema: Schema<Input>;
  outputSchema?: Schema<Output>;
  permission?: ToolPermissionPolicy;
  execute(input: Input, context: ToolRuntimeContext): Promise<ToolHandlerResult<Output>>;
};
```

The model sees the tool name, description, and input schema. It does not see `ToolRuntimeContext`.

Tool execution service:

```ts
interface ToolExecution {
  authorize(request: ToolExecutionRequest, context: ToolExecutionContext): Promise<ToolAuthorizationDecision>;
  execute(request: ApprovedToolExecutionRequest, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}
```

`authorize` resolves whether the call is allowed, denied, or requires explicit approval. This combines:

- release config tool definitions
- agent tool allowlist
- authenticated user permissions
- tool permission policy
- input preview/risk classification where needed

If approval is required, the agent runtime emits `tool_permission_requested`, pauses the run, and resumes after a permission decision. `execute` must never run a tool call that is denied or still awaiting approval.

V1 keeps the approval event shape in the product contract, but the local HTTP request path does not resume paused runs yet. Until resume support exists end to end, startup validation should reject enabled `approval_required` tool policies instead of accepting a configuration that can only fail at runtime.

`ToolExecutionRequest` should be JSON-serializable and worker-friendly:

```ts
type ToolExecutionRequest = {
  toolName: string;
  toolCallId: string;
  agentRunId: string;
  conversationId: string;
  agentName: string;
  input: unknown;
};
```

The tool execution layer owns input validation against the registered tool schema before the tool handler receives typed input. A worker may validate again defensively, but callers should not need to know a tool's implementation details.

`ToolExecutionContext` is infrastructure context, not model-visible input:

```ts
type ToolExecutionContext = {
  user: AuthenticatedUser;
  correlationId: string;
  deadline?: Date;
  signal?: AbortSignal;
  permissionDecision?: ToolPermissionDecision;
  secrets?: ScopedSecretResolver;
};
```

Do not pass raw database handles, global environment secrets, or broad service containers into customer-specific tools. Tools should receive explicit capabilities and scoped secrets only when their definition is allowed to use them.

`ToolExecutionResult` should be structured:

```ts
type ToolExecutionResult =
  | {
      status: "success";
      output?: unknown;
      privateOutput?: unknown;
      display?: ToolDisplayOutput;
      artifacts?: ManagedArtifactRef[];
      auditSummary?: AuditSafeSummary;
    }
  | {
      status: "failed" | "cancelled" | "timed_out";
      error: ToolExecutionError;
      auditSummary?: AuditSafeSummary;
    };
```

`output` is the durable structured result available to the agent and should contain the model-relevant result. Do not use a `modelSummary` field to silently replace tool output. If an oversized result must be bounded for a provider request, the model-context projection layer should create a bounded preview while retaining the full durable output or artifact reference.

`privateOutput` is never sent to the model and never becomes agent-visible history. It is for customer data that the platform can use for deterministic rendering, hydration, storage, export, or other non-model workflows.

`display` is the umbrella field for user-facing rendered output or renderable view data, including typed tool-result renderers, model-authored HTML, registered widgets, and private hydrated visualizations. Platform packages own generic display contracts and fallback frames; customer/demo widgets live in client assembly or deployment code. Private hydrated visualizations return zero-data model-visible acknowledgements by default; query tools that intentionally expose data to the model should be separate tools using normal `output`.

`auditSummary` must avoid raw sensitive payloads.

## Type Boundary

Public package, SDK, API, config, persistence, and inter-package contracts should use product-owned stable types. External types from assistant-ui, Vercel AI SDK, Mastra, LangChain, or other libraries may be used inside implementations and adapters.

## V2 Preparation Rule

When v1 "prepares for" a v2 capability, that means interface-only preparation: product-owned contracts, package boundaries, and config shapes where useful. It should not mean half-implemented features, hidden runtime behavior, or premature operational dependencies.
