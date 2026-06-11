# V1 Realignment Plan

Date: 2026-06-10
Status: proposed

The implementation tracks the planning decisions well overall: product-owned contracts in `chat-core`, a thin client assembly, startup closure validation, minimized audit, and interface-only v2 preparation. This plan closes the places where the implementation has drifted from the planning rules — mostly at the API boundary and in dependency direction — plus small package hygiene. It covers six findings from the post-implementation structure review and sequences them.

The goal is realignment, not restructuring. The package split stays; wrong package edges are expensive, wrong package counts are not.

## Decisions

These decisions are made; record each as a short ADR or working-note entry as part of the workstream that implements it.

1. **Chat stream wire format: product-owned contract, wire-compatible with the AI SDK.** `api-contract` defines zod schemas for exactly the stream chunk types the server emits. The format is wire-compatible with the Vercel AI SDK UIMessage stream protocol as an implementation convenience, but the contract package is the definition; an AI SDK upgrade that changes the wire format is a contract change, not a silent drift. A fully custom protocol is rejected for v1 because it would require a custom client transport for assistant-ui with no product gain.
2. **Non-streaming send path: removed.** `POST /api/conversations/:id/messages` has no consumer; route, contract entry, and `api-client.sendMessage` are deleted, along with `ConversationWorkflow.sendMessage`/`collectAgentRun`. `startMessageRun` and the persistence/audit internals the stream route uses stay. A headless/simple API may reintroduce a blocking send deliberately when a consumer exists.
3. **History ownership: the runtime owns it.** `StartAgentRunInput` keeps its planned shape (`conversationId` plus one message); the runtime resolves prior turns through a narrow `ConversationHistoryReader` seam. Passing history through the HTTP layer is rejected because it leaks history policy into the wrong layer and changes the planned contract.
4. **Renames: both, now, before any external publishing.** `chat-core` becomes `core` (it holds identity, audit, usage, file, tool, and runtime contracts — nothing chat-specific) and `client-instance` becomes `client-assembly` (matches the planning vocabulary and removes the collision with `clients/`).

## Workstream 1: Chat API Contract

**Problem.** The path the UI and e2e tests actually use (`POST /api/chat` in `chat-server/src/routes/chat-stream-routes.ts`) is not in `api-contract`; its request schema is inline and its response is the AI SDK UIMessage stream. The contracted send path is effectively dead. This inverts the schema-first decision: the contract documents the corridor nobody walks down.

**Target state.**

- The stream request schema lives in `api-contract` and is imported by the server route, like every other route.
- The stream chunk contract is product-owned per decision 1; the AI SDK remains an internal implementation detail behind it, and the route emits only contracted chunk types.
- The dead send path is removed per decision 2.
- `events: z.array(z.unknown())` no longer appears in the contract; agent runtime event shapes get real schemas.

**Steps.**

1. Write the ADR for decision 1 (product-owned stream contract, AI SDK wire compatibility as implementation note).
2. Move the chat stream request schema into `api-contract`; delete the inline copy.
3. Define product-owned stream chunk schemas in `api-contract` for the emitted set (start, start-step, text-start, text-delta, message-metadata, text-end, finish-step, finish, error) and validate the route's writes against them.
4. Remove the non-streaming route, contract entry, and `api-client.sendMessage`; delete `ConversationWorkflow.sendMessage`/`collectAgentRun`.
5. Re-point unit tests at the stream path so the tested path is the shipped path.

**Acceptance.** Every route registered in `chat-server` validates its body against an `api-contract` schema. No route exists without a consumer. E2e and unit tests exercise the same send path the UI uses.

This workstream is also the natural vehicle for the existing follow-up note about deepening `api-contract` into an operation catalog; do not block realignment on the catalog, but avoid adding a third place where paths and methods are maintained by hand.

## Workstream 2: Conversation History

**Problem.** `LocalAgentRuntime.executeRun` builds the model messages as `[system, latest user text]`. Persisted conversations never reach the model; the runtime has no store dependency and ignores prior turns. Multi-turn chat does not actually work as a product feature yet.

**Target state.** The runtime resolves prior turns from `conversationId` through a narrow product-owned seam:

```ts
interface ConversationHistoryReader {
  listRecentMessages(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    limit: number;
  }): Promise<ChatMessage[]>;
}
```

`chat-core` owns the interface; `PlatformStore` already satisfies it structurally. `LocalAgentRuntime` receives a `ConversationHistoryReader`, not the whole store.

**Steps.**

1. Add the reader interface to the contracts package; wire it in the client assembly package.
2. Load the last N messages (fixed constant first; release-config bound later only if a workflow needs it) and map them into `ModelMessage[]` before the new user message.
3. Keep v1 deliberately simple: no summarization, no token-budget trimming beyond the message cap. Interface-only preparation applies here too.
4. Add a runtime test proving a second turn sees the first turn.

**Acceptance.** A two-turn conversation answers a follow-up question that requires the first turn. The runtime depends on `ConversationHistoryReader`, not `PlatformStore`.

## Workstream 3: Usage Governance Lock Scope

**Problem.** `ModelUsageGovernance.runModelCall` holds the per-instance lock across the entire provider call, including consuming the full stream. The plan called for serialized *accounting*; the implementation serializes *execution*. One user's long completion blocks every other user of the instance.

**Target state.** The lock covers limit-check plus a lightweight reservation only. The provider call runs outside the lock. Actual usage is recorded on completion; the reservation is reconciled or released. Bounded overshoot from in-flight calls is acceptable and documented.

**Steps.**

1. Split `runModelCall` into `reserve` (locked: assert limits, count the in-flight call) and `settle` (record actual usage, release reservation), with the provider call between them.
2. Count in-flight reservations toward the daily call limit during `assertAllowed`.
3. Tests: concurrent calls do not serialize provider latency; limits still deny at the boundary; a failed call releases its reservation.

**Acceptance.** Two concurrent chat turns on one instance overlap in time. Limit tests still pass.

## Workstream 4: Package Hygiene

**Problem.** Two packages encode no seam, one fallback is silent, and two names will mislead once packages are published.

**Steps.**

1. **Fold `audit` into `chat-core`.** `AuditEventStore` already lives there; move `AuditRecorder`, the store-backed and noop recorders, and `auditActorFromUser` next to it. Update imports in `tool-execution`, `chat-server`, `client-instance`.
2. **Demote `memory-store`.** Move `InMemoryPlatformStore` to a subpath export of the contracts package (`@vivd-catalyst/core/testing` after the rename). It is a reference implementation and test fake, not a storage choice, and must not appear in a customer dependency list as a peer of `postgres-store`.
3. **Remove the silent in-memory fallback.** `createPlatformStore` currently falls back to memory when `DATABASE_URL` is unset, which silently discards conversations, audit events, and usage records on restart. Missing `DATABASE_URL` should fail startup, consistent with assembly validation. Memory mode becomes explicit opt-in (`STORE=memory` or an explicit option on `CreateClientInstanceAppInput`).
4. **Apply the renames (decision 4).** `chat-core` becomes `core`; `client-instance` becomes `client-assembly`. Do both in one pass together with the audit fold and memory-store demotion so imports churn once.
5. **Keep the standing rule.** No new package without a consumer; `retrieval` stays unbuilt until retrieval work starts.

**Acceptance.** `packages/audit` and `packages/memory-store` no longer exist. A client instance without `DATABASE_URL` fails startup with a clear error unless memory mode was explicitly requested.

## Workstream 5: Config Dependency Direction

**Problem.** `agent-runtime`, `model-provider`, and `usage-governance` import types from `config-schema`, and `LocalAgentRuntime` takes the entire `ClientInstanceConfig`. The YAML-parsing package has become a universal dependency, coupling runtime and policy code to the config file format.

**Target state.** `config-schema` is a leaf: it parses and validates YAML into product types owned by the contracts package, then drops out of the picture. Runtime and policy packages depend only on the contracts package.

**Steps.**

1. Move `UsageBudgetConfig`, `UsageSafeguardsConfig`, `UsagePricingConfig`, agent definition, and model provider option types into the contracts package as product types (usage types partially exist there already; merge rather than duplicate).
2. `config-schema` keeps the zod schemas, YAML loading, and helpers (`getAgentConfig`, `getEnabledToolNames`), all returning contract types.
3. Narrow constructor inputs: `LocalAgentRuntime` takes the resolved agent map and default provider lookup it needs, not `ClientInstanceConfig`.
4. Verify with the dependency graph: only `client-instance` (and `chat-server` for safe-config exposure) may depend on `config-schema`.

**Acceptance.** `agent-runtime`, `model-provider`, and `usage-governance` have no `config-schema` dependency in their package.json.

## Workstream 6: Storage Driver Unification

**Problem.** `auth` uses `pg` (node-postgres) while `postgres-store` uses `postgres` (postgres-js). Every deployed instance ships two drivers and two pools with different TLS, timeout, and type-parsing behavior.

**Steps.**

1. Standardize on postgres-js (the larger adapter and the migrations are already written against it; Better Auth's Drizzle adapter is driver-agnostic).
2. Switch `auth/standalone-auth.ts` to `drizzle-orm/postgres-js`; remove the `pg` dependency.
3. Optionally share one connection-options helper in `client-instance` so auth and store read the same env contract.

**Acceptance.** One Postgres driver in the lockfile for a built client instance. Auth and store connect with consistent options.

## Workstream 7: Chat UI Entry Points

**Problem.** `chat-ui` exports only `ChatShell`, but the package contains login, governance client, and the superadmin panel. The embedded widget builds against control-plane code it must never show.

**Target state.** One package, split entry points: `@vivd-catalyst/chat-ui/shell` (chat + login) and `@vivd-catalyst/chat-ui/admin` (superadmin/governance). `chat-widget` imports only the shell entry. The full control-plane package split stays deferred per the working notes, until governance grows beyond the current panel.

**Acceptance.** The widget bundle contains no superadmin or governance module. The standalone app imports both entries explicitly.

## Sequencing

1. **ADRs** recording the decided outcomes above (stream wire format, dead path removal, history ownership, renames). Everything else follows mechanically.
2. **Workstreams 1 and 2** — the contract drift and the missing history are the two product-visible gaps; do them before more UI or tooling work builds on the current wire format.
3. **Workstream 3** — before any real multi-user usage of an instance.
4. **Workstreams 4 and 5** — package folds, fallback removal, renames, and dependency inversion belong together in one "boundary hygiene" pass, and must land before any external package publishing.
5. **Workstreams 6 and 7** — opportunistic; bundle with the next touch of `auth` and `chat-ui` respectively.

## Out of Scope

- Run-state persistence and multi-replica streaming: accepted v1 trade-off; the `AgentRuntime` seam is the planned fix.
- Control-plane package split: deferred follow-up in the working notes; workstream 7 covers the v1 need.
- Full operation catalog for `api-contract`: direction noted in workstream 1, not a realignment blocker.
- Tool worker process implementation: interface-only preparation stands.
