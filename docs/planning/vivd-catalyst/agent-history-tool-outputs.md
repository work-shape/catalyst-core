# Agent History And Tool Outputs

This note defines the target architecture for tool calls, tool results, and what the agent sees in later model turns. It focuses on agent-visible message history, not the browser-facing stream.

## Goal

Vivd Catalyst should preserve an accurate durable transcript of an agent run:

- user messages
- assistant messages
- assistant tool-call requests
- full tool inputs
- full validated tool outputs
- tool execution errors, including input schema errors, output schema errors, handler failures, cancellations, and timeouts

The agent should be able to use this history to correct itself within the same run and in later turns. If a model calls a tool with invalid input, the schema error should become model-visible feedback rather than disappearing into logs or UI state.

The stored transcript should not be mutated into a summary during the session. Later context management may compact or bound what is sent to a model call, but that is a projection of the durable transcript, not a rewrite of the transcript itself.

## Reference Pattern: OpenCode

OpenCode is a useful reference because it separates durable session state from model-context projection:

- Tool calls and tool inputs are persisted as assistant message parts before side effects run.
- Successful tool results and tool errors are persisted as tool-call state.
- Later model messages are reconstructed from the persisted message parts, including tool inputs, outputs, and errors.
- Invalid tool arguments are converted into model-facing feedback so the model can retry with corrected input.
- Oversized tool outputs are bounded for model context with a preview while retaining the full content in managed storage.
- Automatic compaction is a whole-session/provider-request concern. It runs when the next request would overflow the selected model context window minus configured headroom.
- Opencode uses configurable guards: tool output preview defaults around 2,000 lines / 50 KiB, compaction keeps recent context with configurable buffer/keep settings, and model continuation has a step guard plus repeated-tool-call detection rather than a small product-level round cap. Its v2 runner currently uses a 25-step guard, but Vivd Catalyst can start higher if document-heavy workflows need more room.

The direction for Vivd Catalyst is the same separation: preserve the full history, then derive a safe, bounded active model context from it.

## Current Implementation Gap

The current local runtime has a real agentic loop inside one request: the model can call tools, tool results are appended to the in-memory provider messages, and the runtime can ask the model for the next step. Tool execution already returns validation and handler errors in a structured envelope.

The broken part is replay across later turns. Persisted conversation history currently rehydrates user and assistant text, but not prior tool calls, tool inputs, full tool outputs, or tool errors. That means the stored conversation is not yet the agent-visible history.

The current runtime also has a small fixed model-round cap. Product direction is no semantic cap like this. Use a generous configurable guard only to prevent runaway loops, repeated identical tool calls, deadlines, budget failures, or explicit user cancellation.

## Model Tool Definitions

For a normal tool, the model should receive:

- stable tool name
- concise tool description
- input schema

The model does not need the output schema by default. Output schemas are still useful as runtime contracts: validating handler output, validating tool adapters, generating tests, and supporting typed displays.

Tool input is therefore mainly defined by the input schema plus the tool description. Runtime-only context such as authenticated user, deadlines, cancellation, scoped secrets, correlation ids, and permission decisions must stay outside model-visible input.

## Tool Result Shape

Use the smallest result shape that makes visibility explicit:

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

`output` is the durable model-visible tool result. It should contain the information the agent needs, in the shape the tool wants the agent to reason over. It replaces the current `modelSummary` direction.

`privateOutput` is never sent to the model and never becomes agent-visible history. It is for customer data that the platform may use for deterministic rendering, hydration, storage, export, or follow-on non-model workflows.

`display` is a rendered or renderable user-facing surface. It may point to platform-rendered HTML, a registered widget/view model, or a private hydrated visualization. The model should receive only a small `output` acknowledgement unless it genuinely needs display metadata.

`artifacts` are references to managed files or stored outputs. They let tools avoid stuffing large bytes into model context while preserving retention and deletion semantics.

`auditSummary` remains minimized governance metadata and must not contain raw sensitive payloads.

Do not add `modelSummary` as a parallel field. If an oversized `output` must be reduced for one provider call, do that in the model-context projection layer and retain the full output in durable storage.

## Agent-Visible History

Agent-visible history should be append-only except for retention/deletion workflows and explicit operational repair. A persisted tool call should include:

- tool call id
- tool name
- normalized input
- authorization outcome where relevant
- status
- validated `output` or `error`
- references to `privateOutput`, `display`, and `artifacts` where they exist
- timestamps/correlation ids needed for debugging and audit joins

When constructing a provider request, the runtime projects this durable history into provider-specific messages. That projection may:

- omit `privateOutput`
- include `output` as model-visible tool result content
- include tool errors as model-visible tool error content
- replace extremely large `output` with a bounded preview plus an artifact/reference marker
- include a compaction checkpoint for older history once context management exists

The projection must not silently erase the fact that a tool call happened, what input the agent supplied, or what error came back.

## Module Shape

Introduce a `ModelContextProjection` module as part of the main implementation. This should be a real deep module, not a pass-through adapter. Its interface is the test surface for the data-critical model visibility rules:

- exclude `privateOutput`
- exclude `display` payloads unless a future variant explicitly marks model-visible display metadata
- include tool-call inputs, model-visible tool outputs, and tool errors accurately
- apply configurable output bounding
- emit model-visible bounding markers
- insert future compaction artifacts
- adapt durable agent-visible history to provider-specific message formats

This passes the deletion test: without this module, privacy filtering, output bounding, compaction insertion, tool-error replay, and provider formatting would reappear across the local runtime, history replay, tool result handling, and tests.

Keep the agentic loop as an internal implementation detail of the local `Agent Runtime` adapter for now. A public loop seam would be hypothetical until there is a second runtime adapter or a materially different loop implementation. The loop can still be internally split for readability.

Introduce a `ToolResultSettlement` module only if result handling starts spreading across the runtime, storage, UI stream, and audit code. Its job would be to turn a `ToolExecutionResult` into durable history records, model-visible output, private output storage, display delivery, and audit/trace metadata. Do not add it as a broad seam before the implementation proves that locality is being lost.

Defer a broad display delivery seam. For v1, `display` needs a small contract and renderer/registry path, but a larger display module should wait until there are multiple display variants or customers forcing variation.

## Agentic Loop

The runtime loop should be:

```text
load durable agent-visible history
append new user input
project active model context
call model with available tools
if model returns tool calls:
  persist tool call requests and normalized inputs
  authorize/execute tools
  persist success/error/cancel/timeout results
  continue with a new model turn
if model returns final assistant text:
  persist assistant message
  finish run
```

The loop stops only when:

- the model produces a final assistant response without more tool calls
- the user cancels/stops the run
- deadline, budget, or policy says to stop
- the run hits a generous configurable step guard
- repeated identical tool calls trigger a configurable doom-loop guard
- a fatal runtime/provider error prevents continuation

There should be no small fixed limit such as "four model rounds" in the product architecture. A guard is operational safety, not the normal control flow. Repeated identical tool-call detection is a good v1 safeguard because it catches a real failure mode without limiting legitimate multi-step work.

## Context Bounds And Compaction

Context management is separable from the main history fix. The next context-management step should be whole-session compaction: keep the durable transcript complete, then compact only the active model-context projection when the next provider request would exceed the configured context budget.

Near-term direction:

- Tool outputs should be intentionally designed to return the model-relevant result, not raw unbounded customer data.
- Runtime output bounding is a v1 model-context projection guard with configurable limits.
- The default should be moderate rather than huge. A starting point around 60k model-visible tool-output tokens is plausible for document-heavy workflows, with per-client, per-agent, or per-tool overrides.
- The full tool output remains durably stored even if the active model context receives a preview.
- Any bounding marker should tell the model that content was bounded and where the full managed artifact exists if the agent is allowed to request it.
- Projection bounding should produce structured logs and audit/trace metadata with the tool call id, original size estimate, projected size, configured limit, and artifact reference.
- The user should get visible feedback when a document or tool output was not fully loaded into active model context. The wording should avoid implying data loss: the full artifact is stored, but the agent saw only a bounded projection.

Compaction direction:

- Estimate the full model-visible request before each provider call.
- Trigger compaction when the request would exceed the selected model context window minus configured headroom.
- Preserve recent history verbatim within a configurable token budget.
- Compact older history into a synthetic model-context artifact without changing the durable transcript.
- Make defaults model-aware and configurable. A large-context default can target a threshold around 250k tokens, but this should be policy/config rather than a hard-coded constant.

## Display And Private Data Visualization

Two platform tools are planned:

1. `renderHtml`
   - Built-in platform tool.
   - Input includes HTML and a display mode such as `inline` or `side_panel`.
   - Rendered HTML should have Tailwind CSS and Lucide icons available by default, so agents can use Tailwind utility classes and Lucide `data-lucide` icon markers without bundling those libraries into every tool call.
   - The agent authored the HTML, so the tool result does not need to echo HTML back in `output`.
   - Model-visible `output` can be a small acknowledgement such as "HTML display rendered" plus display id/mode if useful.

2. `data.<source>.render_view`
   - Built-in platform/customer-configured tool per data source.
   - The tool description explains the configured data source and allowed query surface.
   - Input includes a query and an HTML/template or registered view reference.
   - The tool runs the query, hydrates the view deterministically, and renders it for the user.
   - Hydrated views use the same visualization runtime as `renderHtml`: Tailwind CSS and Lucide icons are available in the rendered iframe.
   - Raw rows and hydrated private data go into `privateOutput` or managed storage, never into agent-visible history.
   - Model-visible `output` defaults to a zero-data acknowledgement only, such as display id and display mode. It must not include row counts, column names, query-result shape, aggregates, examples, or plain-language facts derived from private rows unless explicitly configured for a non-private tool.

Prefer one generated tool per configured data source at first. This lets the normal tool name, description, and input schema describe what the agent can query without inventing a separate data-source discovery protocol.

### Private Data Boundary

`data.<source>.render_view` is a private rendering tool, not a query tool. Its invariant is:

```text
private query result -> privateOutput/display hydration only -> user display
model-visible output -> zero-data acknowledgement
```

The implementation should make this boundary obvious in code. Put a short comment at the model-context projection/serialization boundary, close to the code that converts tool results into model messages:

```ts
// Data-critical boundary: privateOutput and private rendered data must never be
// serialized into model-visible history. data.<source>.render_view returns only
// a zero-data acknowledgement unless the tool is explicitly a non-private query tool.
```

For non-critical data, use a separate normal query tool. That tool can return rows or summaries through `output`, making the data part of agent-visible history. The agent can then use `renderHtml` to create a visualization from data it is allowed to see.

### Data Source Configuration

Data sources should be configured in release config and validated at startup. Secrets stay in the deployment secret store or environment and are referenced by name.

Suggested v1 shape:

```yaml
dataSources:
  application_data:
    kind: postgres
    connectionRef: env:APPLICATION_DATA_DATABASE_URL
    description: Read-only application reporting database.
    sql:
      dialect: postgres
      access: read_only
      statementTimeoutMs: 10000
      maxRows: 5000
      allowedSchemas:
        - reporting
      schemaDescription: |
        Reporting views for application status, deadlines, and aggregate workflow state.
        Do not query operational auth, audit, or raw document tables.
    tools:
      renderView:
        enabled: true
        name: data.application_data.render_view
        modelVisibleOutput: zero_data_ack
```

Startup validation should prove:

- every configured `data.<source>.render_view` tool has a data source
- every referenced secret exists in the client instance environment
- the connection is read-only or constrained to read-only statements
- the tool name is stable and unique
- the model-facing description does not expose private schema details beyond what the agent needs to write allowed queries
- `modelVisibleOutput` defaults to `zero_data_ack`

Do not add a generic data-source discovery protocol in v1. One generated tool per source keeps the normal tool name, description, and input schema as the agent-facing discovery surface.

`display` is the accepted umbrella field for user-facing tool output. Its variants can include model-authored HTML, registered widgets, typed view models, and private hydrated views. Keeping one field avoids splitting the result contract by implementation source.

Prebuilt widgets remain first-class by using `display` with registered view types and typed view models. Platform packages should define generic display contracts and fallback frames; concrete customer/demo widgets live in client assembly or deployment code.

## V1 Defaults

- Runtime step guard defaults to 64 model steps and is configurable through release config, with an optional per-agent override.
- Repeated identical tool calls default to a limit of 3 allowed repeats before the runtime returns a model-visible `repeated_tool_call` error.
- Tool-output projection bounds default to about 60k estimated tokens, with an optional byte limit.
- V1 ships `renderHtml` and private `data.<source>.render_view` platform tools. It does not ship a generic non-private query tool by default; add explicit query tools only when that data is intended to become model-visible `output`.
