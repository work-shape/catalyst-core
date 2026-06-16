# Frontend, UI, And API Client

The stack should provide both an embeddable chat UI and a standalone surface. The chat experience itself should be the same chat in both places.

## UI Stack

- assistant-ui is the default candidate for shared chat UI primitives/runtime.
- shadcn/ui plus Tailwind is the default component/styling layer for non-assistant UI such as login, navigation, buttons, forms, and control-plane panels.
- Use assistant-ui only if it remains fully customizable.
- Do not use Assistant Cloud for auth, persistence, or conversation storage.
- Keep auth, persistence, audit, and conversation storage in our own backend/Postgres.

Recommended packages:

```text
chat-ui          shared chat components and state
chat-widget      embedded shell
chat-standalone  full-page/local chat shell
control-plane    settings/governance/admin shell, may live inside chat-standalone initially
```

The shared `chat-ui` package may wrap assistant-ui components/runtime internally, but the product should expose its own UI composition boundary so embedded and standalone chat surfaces are not coupled directly to assistant-ui decisions.

Non-chat primitives should follow shadcn/ui copy-owned component conventions rather than custom local class systems. Customer branding should be applied through shadcn/Tailwind CSS variables, not bespoke component APIs.

## Standalone Surface And Control Plane

The standalone surface serves two purposes:

1. **Direct chat access**
   - Same chat experience as the embedded widget.
   - Useful for local testing, demos, and direct access through a domain.

2. **Control plane**
   - Basic configuration and governance screens.
   - Can start as routes inside `chat-standalone`.
   - May become a separate package/shell later if it grows.

V1 control-plane candidates:

- view active client-instance release config and config snapshots
- view own conversations
- delete own conversations where allowed
- superadmin usage panel led by budgeted model cost summaries, with model calls, provider-reported tokens, configured pricing, spend budget, late safeguards, and recent model usage events as supporting context
- admin/superadmin view for governance tasks
- superadmin user administration for product-owned users, roles, permission refs, status, and user identity mappings
- inspect/delete conversations and related data where legally/contractually permitted
- view audit and retention-job status

Admin/superadmin access must be explicit, permissioned, and audited. Sensitive-data workflows should not allow broad invisible access to user conversations without a governance reason.

By default, admin/superadmin views should show metadata, deletion workflows, export/request-handling tools, and audit status. Full conversation message access should require an explicit config flag, a permission check, and an audit reason.

User administration manages product-owned user records and identity mappings. It is not a general auth-provider console in v1: password reset, invite, and credential lifecycle flows should be added only when a concrete standalone-account workflow requires them.

The normal chat rail should stay focused on conversations and a single New action. Superadmin/control-plane access should not appear as a primary Chat/Usage segmented control; it should be tucked behind a secondary superadmin-only action because most users will never see or need it.

Composer text drafts belong to the active conversation target in frontend state. V1 should not persist every keystroke to the backend. Dropped files are different: they become persisted Draft Attachments with upload/preprocessing state because preprocessing may outlive the current browser view and must survive refreshes.

Conversation rows should show a short generated title after the first user/assistant exchange. The backend owns title generation, persistence, usage accounting, and audit events; assistant-ui may render thread titles, but Assistant Cloud auto-title behavior is not used because conversation storage remains in our backend/Postgres. Title generation is navigation metadata only, not a retained conversation summary for model context. The first implementation uses a temporary first-message title immediately, then refreshes the conversation list after the stream finishes so the generated title appears without a separate UI control.

## Domain UI Outputs

V1 should support typed UI extension points for domain-specific outputs. The first likely example is document processing:

```text
document analysis panel
  -> list uploaded/acquired documents
  -> show extracted fields per document
  -> show confidence/warnings
  -> show comparison against application/email statements
  -> link back to source document
```

These extension points should be typed product surfaces, such as `DocumentAnalysisViewModel` or `ToolResultViewModel`, rather than arbitrary injected frontend code. This keeps the chat shell customizable for real workflows without committing to a broad plugin system in v1.

Tool executions expose these user-facing surfaces through the `display` output field. `display` is the umbrella channel for typed domain views, registered widgets, model-authored HTML, and private hydrated views; the UI decides how to render the display variant while the agent-visible `output` remains separate.

## Streaming Chat Path

Vercel AI SDK is the default v1 internal candidate for model calls, streaming, provider adapters, and tool-call plumbing. It should stay behind product-owned `Agent Runtime`, `Tool Execution`, API, and message contracts.

Current v1 implementation status: the backend persists the submitted user message, runs the agent, streams Vercel AI SDK UI message chunks over `/api/chat`, persists assistant messages from runtime completion events, and records minimized run/tool audit metadata. assistant-ui consumes that stream through `@assistant-ui/react-ai-sdk` inside `chat-ui`; API/auth/persistence remain product-owned.

Current chat-ui implementation status: the active chat surface wraps assistant-ui primitives behind `AssistantChatPanel` and product-owned components. The first polished assistant-ui pass includes Thread/Viewport, Composer, ActionBar copy, markdown/GFM rendering, syntax-highlighted code blocks, error rendering, suggestion prompts, generic tool-call/data part rendering, a visible stop/cancel action while running, and disabled attachment/edit/regenerate affordances where the backend workflow is not complete yet.

Assistant-ui alignment direction: tool calls should follow the assistant-ui `ToolGroup`/`ToolFallback` pattern with grouped adjacent tool parts, a real collapsible trigger, compact fallback rows, and custom tool UIs registered through `Tools({ toolkit })` where the tool name is known. Vivd's product-owned `display` payload remains the private/custom widget contract; assistant-ui registration is the rendering hook, not the domain data contract.

Near-term UI follow-ups: adapt the conversation rail toward assistant-ui `ThreadList`/`ThreadListSidebar` styling while keeping Postgres/TanStack Query conversation ownership; evaluate `@assistant-ui/react-streamdown` when richer streaming markdown such as Shiki, KaTeX, or Mermaid is needed; wire assistant-ui attachment adapters/primitives only after storage, retention, audit, and preprocessing contracts are finalized; use assistant-ui `AssistantModal`/`AssistantModalPrimitive` as the script-injected assistant surface.

Current title implementation status: conversation rows store `title` in Postgres. New conversations start with a local first-message title, then the conversation workflow performs one best-effort model call after the first assistant response when the title still looks temporary. The title prompt is capped to the first user and assistant texts and asks the model to avoid personal data in the headline. Success writes `conversation.title_generated`; failure writes `conversation.title_generation_failed` and does not fail the chat turn.

Deferred v1 UI controls: feedback/export and branch picker are intentionally out of scope for the next polish pass. Attachment acquisition/upload, dropzone enablement, message editing, and regeneration should move from disabled affordances to active controls only when the corresponding backend contracts and audit semantics are implemented.

## File Attachment Dropzone

When managed file upload is enabled, the drop target should be the whole active chat area, not only the composer. In the standalone shell this means the entire surface to the right of the conversation/sidebar rail: thread viewport, empty state, composer area, and any chat-level chrome. The sidebar should not become a file drop target because dragging over conversation navigation should not accidentally attach files to the active draft.

Expected behavior:

- dragging files over the chat area shows one clear full-surface drop overlay for the active conversation or new-message draft
- dropping files anywhere in that area starts the managed file acquisition/upload flow
- dropping files on the unsent New conversation screen creates a persisted Conversation shell first, so Draft Attachments always have a `conversationId` owner
- conversations created by file drop use a temporary file-based title, such as the filename for one file or "`n` attached files" for multiple files
- the browser's default file-open behavior is prevented while files are dragged over the chat surface
- unsupported file types, too-large files, and upload failures are reported in the composer attachment area without sending a message
- supported text-related files enter document preprocessing immediately after upload; the user can keep typing and dropping more files, but message submission is blocked while any attachment is uploading, queued, preprocessing, failed, or unsupported
- preprocessing concurrency is configurable; queued Draft Attachments show pending processing state until capacity is available
- failed or unsupported Draft Attachments must be removed or retried successfully before sending
- likely duplicate files, such as matching filename and size in the same conversation, may show a confirmation hint before uploading again; continuing creates a separate Draft Attachment rather than deduplicating
- upload/preprocessing state is persisted as Draft Attachments so switching conversations or refreshing the browser restores each attachment's status
- successfully processed files are represented as managed file references and preprocessing metadata attached to the conversation draft, not as raw bytes or full text in UI state
- pre-send attachment chips should stay minimal: filename, status, and file size; do not show extracted text, and do not require word/page counts in this UI
- sending the message passes text plus managed file refs to the backend; the agent sees an Attachment Manifest and can choose `read_document` when document contents are needed
- drag/drop should work consistently in embedded and standalone chat shells, with the drop scope adapted to each shell's main chat container

```text
assistant-ui
  -> @assistant-ui/react-ai-sdk
  -> Vercel AI SDK transport/streaming
  -> our schema-first chat API
  -> our AgentRuntime
```

## Normal Frontend Server State

TanStack Query is the default for frontend server state outside the Vercel AI SDK streaming chat path:

- conversation lists
- conversation metadata
- authenticated user state
- config and feature flags
- file/upload metadata
- feedback mutations

TanStack Router is the default for the standalone chat UI and any future admin/config UI. The embedded widget should stay router-light unless the embedded experience grows beyond a compact chat surface.

## API Client

The frontend should use a generated or generated-assisted API client for normal HTTP operations. The source of truth should remain the backend's schema-first HTTP contract.

```text
api-contract Zod/product schemas
  -> server route validation
  -> OpenAPI contract
  -> generated API client package
  -> TanStack Query wrappers/query options
  -> chat-widget and chat-standalone
```

The API contract package should be the shared module. The server should not import from the API client adapter; the API client should consume and re-export contract schemas/types where useful.

The generated API client should cover normal request/response operations such as conversations, config, authenticated user state, file metadata, feedback, audit views, and superadmin usage summaries. The live chat stream may use assistant-ui/Vercel AI SDK transport primitives instead of being treated as a normal TanStack Query request.

Usage routes must return minimized metadata only: provider id, model id, token counts, derived cost metadata from release-config pricing and the cost safety multiplier, timestamps, correlation ids, configured pricing, spend budget, and late safeguards. They must not return prompt or completion payloads.

The conversation list must be user-scoped by the backend. The frontend should not filter another user's conversations out of a shared response.

## Client Branding And Theme

Release config should carry customer-specific branding for a client instance:

- client name
- optional logo URL and dark-mode logo URL; transparent monochrome marks may instead opt into dark-mode inversion
- theme colors for accent, background, surface, text, muted text, and borders
- optional dedicated `uiFile` so client presentation config can live beside, but outside, the main release config

The standalone surface and embed surface should consume the same safe config view. Customer-specific branding should not require forking `chat-ui`.

The safe config view should expose normalized Client Branding. UI code should not know release-config fallback rules such as defaulting the client name from the client instance display name or resolving theme accent aliases.

## Localization

English and German are first-class product locales in v1. Release config owns the supported locale list and default locale. Customer/workflow copy such as agent display names, welcome messages, and suggested prompts stays in client/agent config and may be either a legacy string or an `en`/`de` map. The safe config endpoint resolves those maps server-side for the requested locale, so UI packages consume plain strings and do not know release-config fallback rules.

Product-owned UI chrome such as buttons, placeholders, auth labels, and settings labels lives in typed `chat-ui` dictionaries. Runtime request context carries the resolved locale so agent runs receive one product-owned instruction to answer in the selected language unless the user asks otherwise.

API client generator:

**Hey API / `@hey-api/openapi-ts`** is the default v1 generator candidate. It can generate TypeScript SDKs, Zod schemas, and TanStack Query hooks from OpenAPI, which matches the preferred schema/client/query stack.

If Hey API fails during implementation, evaluate Orval or `openapi-typescript`/`openapi-fetch` as fallbacks.
