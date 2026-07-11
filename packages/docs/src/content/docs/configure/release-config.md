---
title: Release Config
description: Use source-controlled config as the source of truth for instance behavior.
---

Static release config defines the code-deployed ceiling of a client instance. It is version-controlled, validated at startup, and deployed with the client assembly app.

Agents and client skills are separate versioned configuration assets. The Catalyst CLI synchronizes their complete YAML and Markdown working copies with the active instance. Static release config decides which of their fields and operations are additionally editable through interactive administration.

## What Release Config Owns

Release config should cover:

- tool enablement and tool parameters
- model providers and approved model bindings
- capability activation and settings
- interactive agent-configuration policy
- supported locales and default locale
- client branding and theme
- welcome copy, placeholders, and suggested prompts
- retention and deletion policy
- audit retention
- usage budgets and safeguards
- OpenAPI operation selections
- built-in tool enablement

## Example

```yaml
version: 1
clientInstance:
  id: example-support
  displayName: Example Support Chat

administration:
  agentConfiguration:
    enabled: true
    editableAgentFields:
      - displayName
      - welcomeMessage
      - modelBindingId
      - reasoningEffort
      - initialPrompts
    allowAgentCreation: false
    allowAgentDeletion: false
    allowDefaultAgentChange: false
    allowSkillEditing: false

ui:
  clientName: Example Company
  faviconUrl: /favicon.svg
  defaultLocale: en
  supportedLocales: [en, de]
  welcomeMessage:
    en: How can I help with your support case?
    de: Wie kann ich bei deinem Supportfall helfen?
  theme:
    accentColor: "#0f766e"
    backgroundColor: "#f7f7f4"
    surfaceColor: "#ffffff"

retention:
  conversations:
    deleteAfterDays: 90
  audit:
    deleteAfterDays: 730

usage:
  budget:
    monthlySpendLimit: 200
    costSafetyMultiplier: 1.3
  safeguards:
    modelCallsPerDay: 1000
    tokensPerDay: 2500000
```

Usage pricing uses exact `providerId` and `model` rows. Keep historical model ids in this list when old usage should remain priced after a model rename or provider migration.

## Sharing Config Across Environments With `extends`

A config file can start from another config file and override only what differs:

```yaml
# app.staging.yaml
extends: ./app.base.yaml
clientInstance:
  id: example-staging
  environment: staging
auth:
  standalone:
    baseUrl: https://staging.example.test/api/auth
```

Merge rules:

- Objects merge recursively; the extending file wins on conflicts.
- Arrays and scalars replace the base value wholesale — overriding one list entry means restating the whole list.
- `extends` chains are allowed; cycles fail validation with a clear error.
- Relative paths in the merged result (such as `uiFile`) resolve against the entry file's directory, not the extended file's.

Keep everything shared in one base file and put only genuine per-environment differences in the environment files. Reading an environment file should answer "what makes this environment different?" at a glance.

## Tool Configuration

Each tool entry controls whether a stable tool name is available in the client instance. The optional `config` object is passed to the matching configured tool factory and validated by that factory's schema during startup.

```yaml
tools:
  - name: support.lookup_ticket
    enabled: true
    config:
      permissionRef: support-ticket-reader
      endpointEnvName: SUPPORT_API_URL
  - name: support.create_escalation
    enabled: false
```

Use `config` for customer-specific values such as permission references, default currencies, endpoint names, model-facing labels, allowlists, and secret environment variable names.

Do not put secret values in `config`. Put secret values in environment files or a secret manager, and reference them by name.

Startup validation fails when:

- an enabled tool has no registered implementation
- a configured tool's `config` does not match its schema
- an agent references a disabled or missing tool
- an enabled tool requires approval before approval resume is implemented

## Agent And Skill Configuration Assets

Agents and client skills remain source-controlled YAML and Markdown, but runtime reads them from the versioned configuration-asset store. A `catalyst.yaml` manifest selects the working-copy files and target instances:

```yaml
instances:
  staging:
    url: https://catalyst.example.test
defaultInstance: staging
defaultAgentName: support_agent
agents:
  - agents/*.agent.yaml
skills:
  - skills/*/SKILL.md
```

Use `catalyst config pull`, `diff`, `validate`, and `push` to synchronize the complete entities. Push uses the last pulled version and conflicts when the active instance changed in the meantime. The CLI release path has full entity access; ordinary administration writes are limited by `administration.agentConfiguration` and enforced by the server.

An agent YAML file contains its behavior and grants:

```yaml
name: support_agent
displayName: Support Agent
instructions: Help users with support cases.
modelBindingId: primary
reasoningEffort: medium
toolNames:
  - read_skill
  - support.lookup_ticket
skillNames:
  - support_review
initialPrompts: []
```

Each skill file starts with YAML frontmatter:

```md
---
title: Support Review
description: Use when the user asks to review support case details and plan next checks.
---

# Support Review

...
```

The model sees only the allowed skill name, title, and description. It calls `read_skill` to load the full Markdown body when a skill matches the task.

## UI Branding

The platform shell provides `/favicon.svg` as the default favicon. Standard Vite clients use `vivdCatalystChatUiPlugin()` from `@vivd-catalyst/chat-ui/vite` to serve and copy that default unless the client provides its own `public/favicon.svg`. Set `ui.faviconUrl` when a client needs its own icon at another URL; the value may be an absolute URL or a root-relative path served by that client.

## Model Provider Configuration

OpenAI-compatible providers keep API-specific request shapes behind the model-provider boundary. Agents and tools still see Vivd Catalyst's provider-neutral messages, tools, tool calls, tool results, and usage.

Use `api: responses` for OpenAI reasoning models that combine reasoning, tool calling, or multi-turn workflows. Leave the field unset, or set `api: chat_completions`, for legacy OpenAI-compatible endpoints that still expect `/chat/completions`.

```yaml
modelProviders:
  - id: openai
    type: openai-compatible
    api: responses
    model: gpt-5.5
    reasoningEffort: high
    baseUrl: https://api.openai.com/v1
    apiKeyEnvName: OPENAI_API_KEY
modelBindings:
  - id: primary
    providerId: openai
    model: gpt-5.5
    reasoningEffort: high
    agentSelectable: true
```

Agent configuration may override a binding's default with one of Catalyst's product-owned reasoning efforts: `none`, `low`, `medium`, `high`, or `xhigh`. Only bindings with `agentSelectable: true` are valid agent choices; set it to `false` for internal bindings such as conversation-title generation. Interactive selection is available only when `modelBindingId` and/or `reasoningEffort` appear in `editableAgentFields`. The server validates model-binding references and reasoning values; the UI does not accept arbitrary model identifiers.

## Config Is Not A Secret Store

Release config may reference secrets, but it must not contain secret values.

Use runtime env files or a secret manager for:

- model provider API keys
- database passwords
- customer API credentials
- object storage credentials
- server-to-server token exchange credentials

## Change Flow

Treat config changes like code changes:

```text
edit static release config and/or agent working copy
  -> validate static assembly and agent references
  -> run tests
  -> push versioned agent assets when changed
  -> build and deploy the image when static config changed
  -> record active static and asset versions
```

Interactive administration changes apply to new conversations immediately. Pull and commit those changes when the repository should retain them. Static tool availability, model providers and bindings, capabilities, retention, and security policy still require the normal release/deploy flow.
