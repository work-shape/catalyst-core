---
title: Describe a Data Store
description: "Read a Data Store’s schema, uses and rights without reading records."
---

An agent can call `platform.data_stores.describe` with a store's name before it has tools to read its rows. The answer gives the title and owner, publication status, tables and fields in words, approximate row counts, visible Workflows and Apps that fill or read it, and your rights to read, add or change records. Dependencies come from published definitions; an incomplete dependency listing is marked `usesTruncated`. An unpublished or provisioning store reports `schemaAvailable: false` rather than inventing fields.

This description needs `data_store.read` on that particular store, the same right as its page. It returns no rows, samples, distinct values, SQL or column defaults. Field and table descriptions come from schema comments; when a field has no comment, the answer explains its type and whether it is required. Row estimates come from the database catalog, not a count of records.

The answer also says whether the current agent run has a row-reading tool for this store. Describing it does not add tools or change what the conversation is about. When those tools are missing, it names the next step: `data_store.use`, which adds the store to the chat for reading (see below). Outside clients receive the same metadata through `GET /api/v1/data-stores/{store}/description`; a personal key still cannot read rows.

The description creates no new stored dataset or cache and calls no outside provider: it uses the store's existing Postgres location and platform metadata. Answers in a conversation follow that conversation's retention. Authorization and refusal use the existing operation path; no row payload is added to governance audit records. In shared conversations, an agent describes only the store the conversation is already about; other stores require a private conversation.

## Read a Data Store in a chat

When you ask about the records of a Data Store in a chat that has no tools for it, the agent calls `data_store.use` with the store's name. It adds the store to this chat for reading, next to what the chat is about: the agent gets the store's `describe`, `query` and `preview_rows` tools and no tools that change records. Nothing else about the chat changes.

- **Your own store**, in a chat of your Personal Workspace: it is added at once, and the agent answers from it in the same turn.
- **Any other store** (one of the instance or of a Shared Workspace): you see a card that asks whether the chat may read it. Once you confirm, the chat goes on by itself. In a chat that others in the workspace read, the card says that they will see the answers from the store.

Adding a store grants no right. Every read still checks your `data_store.read` on that store, as the store's page does. Only you can add a store, in your own turn: a subagent, a Workflow step, a scheduled start or a call with a personal key cannot. A store of a Personal Workspace is read only in its owner's own chats there. Each add is recorded in the audit log with the conversation and the store's id, never a record.
