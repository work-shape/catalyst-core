# Data, Storage, And Retrieval

Postgres is the first baseline application store. Vector retrieval is a first-class platform capability, but not a v1 implementation.

## Application Store

Postgres stores normal product data:

- conversations, scoped to an authenticated user
- messages
- audit events
- model usage events
- config snapshots
- user identity mappings
- conversation retention state
- tool call records
- usage summaries for governance and configured limits
- retrieval reference metadata

Concrete SQL store packages should use Drizzle internally for typed schema and query construction. Drizzle table definitions and inferred row types are implementation details of adapters such as `postgres-store`; platform package boundaries should continue to expose product-owned store interfaces and domain types.

The vector storage decision remains separate. Postgres may also provide vector search through pgvector, but the retrieval adapter should avoid coupling the platform to pgvector only.

## Conversations And Retention

The chat persists conversations so users can resume past work. "Session" should be avoided for this concept because auth already uses session tokens.

Baseline rules:

- A conversation belongs to the stable user identity returned by the auth adapter.
- Users see only their own conversations by default.
- A conversation may have a generated title for navigation after the first user/assistant exchange.
- Admin/support visibility requires explicit roles or permissions.
- Conversation history is retained only for a configured duration.
- Retention applies to messages, model inputs/outputs, tool call records, document analysis outputs, and related file references.
- Retention deletion should be automatic, auditable, and testable.
- User-initiated and admin/superadmin deletion should be supported where policy allows it.
- Deletion should cover conversations, messages, tool call records, document analysis outputs, and related file references.

The first implementation should store conversation metadata and messages in Postgres. Sensitive raw files or large derived artifacts may require object storage, but their metadata and retention state should still be tracked in Postgres.

## Retrieval And Knowledge Sources

Retrieval should be a core platform capability, not only custom tool code. Agents should access retrieval through configured knowledge source access, usually exposed to the agent as one or more tool-like capabilities.

Agent config should explicitly declare accessible knowledge sources:

```yaml
agents:
  payslip_agent:
    instructions: ./instructions/payslip.md
    tools:
      - payslip.summarize
    knowledge_sources:
      - payslip_policy_docs
      - payroll_faq
```

Knowledge source definitions should live separately from agent definitions:

```yaml
knowledge_sources:
  payslip_policy_docs:
    type: vector
    provider: <retrieval-adapter-id>
    index: <adapter-specific-index-or-collection>
    permissions:
      mode: user_scoped
```

The platform should own common retrieval concerns:

- document ingestion and chunking
- embedding provider selection
- vector store adapters
- permission filtering
- citation metadata
- retention/deletion behavior
- audit logs for retrieval queries and returned references

## Future Vector Provider Candidates

The first concrete vector provider is not decided yet and should not be selected in v1. The retrieval interface should support cloud-managed stores and VPS-friendly self-hosted stores.

Likely candidates:

- Postgres with pgvector
- Qdrant
- SQLite/LanceDB for small local deployments
- Milvus
- Azure AI Search
- other managed vector databases

Postgres with pgvector is a strong future baseline because Postgres is already likely for application data and can keep a VPS deployment simple. Milvus should also be evaluated as a vector adapter candidate. It may be attractive when vector search grows beyond what pgvector should handle, but likely adds more operational weight than pgvector for a small first client instance.

V1 should define the retrieval interface and configuration shape only. It should not include a concrete vector adapter before a concrete knowledge-source requirement appears.
