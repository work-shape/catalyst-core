# Open Questions

Resolve these in order. Questions in the first section block the first vertical slice; later sections should not slow down initial implementation.

## Blockers Before First Vertical Slice

1. What should the exact customer-backed chat session endpoint schemas and token expiry be?
2. What configurable conversation retention policy shape does v1 need?
3. What data is stored in conversation history, and what must never be stored?
4. What release-config validation must pass before publish/deploy?

## First-Customer Decisions

1. Which optional customer identity claims are required beyond the baseline `AuthenticatedUser` fields?
2. Which deletion actions should normal users get in v1?
3. Which governance actions require admin or superadmin roles?
4. Which admin/superadmin actions require an explicit reason?
5. What audit event types and audit retention policy are required for the first workflow?
6. What document formats must v1 process?
7. Which structured extraction provider should be used after the provider-agnostic interface exists?
8. What UI customizations are necessary for the first workflow, and which are deliberately unsupported?

## Parked For V2 Or Later

1. Where should MCP servers run: backend runtime, customer-hosted infrastructure, or both?
2. Which URL/domain patterns are allowed for agent-driven file fetching?
3. Does a future customer need browser automation, and should it use deterministic Playwright scripts, browser-use, Gemini Computer Use, or a layered approach?
4. Which vector provider should be implemented first, and what would justify Milvus over pgvector or another simpler store?
5. Which config values, if any, should become runtime-editable through the control plane?
6. How should broader UI slots or a headless SDK work?
7. What belongs in a separate isolated agent worker machine versus the client-instance runtime?
