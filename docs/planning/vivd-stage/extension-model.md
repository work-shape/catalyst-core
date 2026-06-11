# Extension Model

The product should be configurable and extensible without becoming a live-mutated visual platform. Custom code tools are the highest-priority extension point.

## Tool Sources

### V1 / Early Sources

1. **Custom code tools**
   - Customer-specific code implements tools that run inside the client instance or one of its execution runtimes.
   - For v1, these can be source files or packages shipped with the dedicated client instance and referenced by stable tool names in config.

2. **OpenAPI API tools**
   - Customer provides an OpenAPI spec.
   - The platform converts selected operations into callable tools.
   - The system must enforce allowlists, schemas, auth mode, data exposure, rate limits, and human-readable tool descriptions.
   - The backing API may be customer-written code, but that code runs outside this product.

3. **Built-in platform tools**
   - Platform-provided capabilities enabled and configured through YAML/JSON.
   - No customer runtime code.
   - Examples: `file.fetch_url`, `document.convert_to_markdown`, `document.extract_structured`, `knowledge.search`.
   - Agent instructions, model settings, and prompts are configuration, but they are not tools.

### Future Sources

4. **MCP tools**
   - Customer provides or runs an MCP server.
   - The platform connects to it and exposes selected MCP tools to agents.
   - The system must define where MCP servers run: customer infrastructure, operated infrastructure, or both.
   - MCP support is v2, prepared in v1 only through tool-source and tool-execution interfaces.

## Custom Code Execution Modes

Use execution modes that fit the code-deployed model first:

- **V1: client-instance source/package tools**
  Customer-specific tool code ships with the client assembly app and is deployed with the dedicated client instance.

- **Future: separate tool worker containers**
  Customer-specific tool code runs in a separate worker process/container inside the client instance infrastructure.

- **Future: isolated agent worker machines**
  Selected jobs dispatch to a separate machine or worker where a coding agent can run custom code and tools.

Because each client runs on separate infrastructure, the isolation problem is primarily between custom code and sensitive systems inside a client instance, not between multiple unrelated customers in one shared runtime.

## UI Extension

UI modifications are required in v1 for domain-specific outputs such as document analysis panels. The goal is not arbitrary frontend plugin execution. The goal is explicit, typed UI extension points for known product surfaces.

Recommended layers:

1. Theme tokens: colors, typography, spacing, logo, border radius.
2. Content config: welcome text, placeholders, empty states, suggested prompts.
3. Feature flags: uploads, citations, conversation history, feedback, escalation, export.
4. Layout options: compact/full chat, docked widget, full-page mode.
5. V1 UI extension points: custom side panel, structured output renderer, document analysis panel, tool-result renderer.
6. V2 UI extension points: broader slot system and headless SDK for customers who build their own UI against the same backend.

The document processing workflow likely needs a custom v1 panel that lists acquired/processed documents and shows structured analysis per document. This should be modeled as a typed product surface, not as arbitrary UI code injected into the chat shell.
