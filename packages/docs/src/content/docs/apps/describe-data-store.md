---
title: Describe a Data Store
description: "Read a Data Store’s schema, uses and rights without reading records."
---

An agent can call `platform.data_stores.describe` with a store's name before it has tools to read its rows. The answer gives the title and owner, publication status, tables and fields in words, approximate row counts, visible Workflows and Apps that fill or read it, and your rights to read, add or change records. Dependencies come from published definitions; an incomplete dependency listing is marked `usesTruncated`. An unpublished or provisioning store reports `schemaAvailable: false` rather than inventing fields.

This description needs `data_store.read` on that particular store, the same right as its page. It returns no rows, samples, distinct values, SQL or column defaults. Field and table descriptions come from schema comments; when a field has no comment, the answer explains its type and whether it is required. Row estimates come from the database catalog, not a count of records.

The answer also says whether the current agent run has a row-reading tool for this store. Describing it does not add tools or change what the conversation is about. When those tools are missing, it explains that `data_store.use` is coming and is not available yet. Outside clients receive the same metadata through `GET /api/v1/data-stores/{store}/description`; a personal key still cannot read rows.

The description creates no new stored dataset or cache and calls no outside provider: it uses the store's existing Postgres location and platform metadata. Answers in a conversation follow that conversation's retention. Authorization and refusal use the existing operation path; no row payload is added to governance audit records. In shared conversations, an agent describes only the store the conversation is already about; other stores require a private conversation.
